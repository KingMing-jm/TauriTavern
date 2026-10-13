use std::sync::Arc;
use tauri::Manager;
use tokio::sync::OnceCell;
use tt_adapter_extension::outfit::{NativeOutfitBackend, OutfitRuntimeConfig};
use tt_application::services::outfit::OutfitService;
use tt_domain::errors::DomainError;
use crate::infrastructure::paths::RuntimePaths;

#[derive(Default)]
pub struct OutfitState {
    bundle: OnceCell<OutfitBundle>,
}

struct OutfitBundle {
    service: Arc<OutfitService>,
    backend: Arc<NativeOutfitBackend>,
}

impl OutfitState {
    pub fn shutdown(&self) {
        if let Some(bundle) = self.bundle.get() { bundle.backend.shutdown(); }
    }
}

pub async fn service<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Arc<OutfitService>, DomainError> {
    let state = app.try_state::<OutfitState>().ok_or_else(|| DomainError::InternalError("Outfit host state is missing".into()))?;
    let bundle = state.bundle.get_or_try_init(|| async {
        let paths = app.try_state::<RuntimePaths>().ok_or_else(|| DomainError::InternalError("Tauri data paths are not ready".into()))?;
        #[cfg(target_os = "android")]
        let node_binary = None;
        #[cfg(not(target_os = "android"))]
        let node_binary = {
            let executable = std::env::current_exe().map_err(|e| DomainError::InternalError(e.to_string()))?;
            let parent = executable.parent().ok_or_else(|| DomainError::InternalError("Application executable has no directory".into()))?;
            Some(parent.join(if cfg!(windows) { "outfit-node.exe" } else { "outfit-node" }))
        };
        let backend = Arc::new(NativeOutfitBackend::new(OutfitRuntimeConfig {
            data_root: paths.data_root.clone(),
            node_binary,
        }));
        let service = Arc::new(OutfitService::new(backend.clone()));
        Ok::<_, DomainError>(OutfitBundle { service, backend })
    }).await?;
    Ok(bundle.service.clone())
}
