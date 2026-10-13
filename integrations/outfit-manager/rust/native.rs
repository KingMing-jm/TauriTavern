//! Concrete IO for the bundled Outfit backend. No Tauri dependency.
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::blocking::Client;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tt_contracts::outfit::{OutfitRequest, OutfitResponse};
use tt_domain::errors::DomainError;
use tt_ports::outfit::OutfitBackend;
use uuid::Uuid;

// Generated from pinned upstream sources plus their installed dependency lock.
include!("outfit_bundle.rs");
const PREFIX: &str = "/api/plugins/outfit-manager/";
const MAX_RESPONSE: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct OutfitRuntimeConfig {
    pub data_root: PathBuf,
    pub node_binary: Option<PathBuf>,
}

pub struct NativeOutfitBackend {
    config: Arc<OutfitRuntimeConfig>,
    state: Arc<Mutex<RuntimeState>>,
}

enum RuntimeState {
    Unstarted,
    Running(NativeRuntime),
    Failed(String),
    Stopped,
}

impl NativeOutfitBackend {
    pub fn new(config: OutfitRuntimeConfig) -> Self {
        Self { config: Arc::new(config), state: Arc::new(Mutex::new(RuntimeState::Unstarted)) }
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            // Dropping a desktop child kills and reaps it. The Android engine is
            // in-process and lives until Android terminates this app process.
            *state = RuntimeState::Stopped;
        }
    }
}

#[async_trait]
impl OutfitBackend for NativeOutfitBackend {
    async fn execute(&self, request: OutfitRequest) -> Result<OutfitResponse, DomainError> {
        let config = self.config.clone();
        let shared = self.state.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = shared.lock().map_err(|_| "Outfit runtime lock poisoned".to_string())?;
            if matches!(*state, RuntimeState::Unstarted) {
                *state = match NativeRuntime::start(&config) {
                    Ok(runtime) => RuntimeState::Running(runtime),
                    Err(error) => RuntimeState::Failed(error),
                };
            }
            match &mut *state {
                RuntimeState::Running(runtime) => runtime.execute(request),
                RuntimeState::Failed(error) => Err(format!("Outfit startup failed; restart the app after correcting it: {error}")),
                _ => Err("Outfit runtime is stopped".to_string()),
            }
        }).await.map_err(|e| DomainError::InternalError(format!("Outfit worker failed: {e}")))?
          .map_err(DomainError::InternalError)
    }
}

struct NativeRuntime {
    process: NodeProcess,
    client: Client,
    port: u16,
    token: String,
}

impl NativeRuntime {
    fn start(config: &OutfitRuntimeConfig) -> Result<Self, String> {
        let data_root = fs::canonicalize(&config.data_root).map_err(|e| format!("Resolve Outfit data root: {e}"))?;
        let data_dir = data_root.join("outfit-manager");
        private_directory(&data_dir)?;
        let code_parent = data_root.join("outfit-runtime");
        private_directory(&code_parent)?;
        let code_dir = install_bundle(&code_parent)?;
        let ready = code_parent.join(format!("ready-{}.json", Uuid::new_v4().simple()));
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut process = NodeProcess::start(config, &code_dir.join("launcher.cjs"), &data_dir, &ready, &token)?;
        let deadline = Instant::now() + Duration::from_secs(120);
        let port = loop {
            if let Some(exit) = process.exited()? {
                return Err(format!("Bundled Node runtime exited before readiness: {exit}"));
            }
            match fs::read(&ready) {
                Ok(bytes) => {
                    if bytes.len() > 16 * 1024 { return Err("Oversized Outfit readiness record".into()); }
                    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid Outfit readiness record: {e}"))?;
                    fs::remove_file(&ready).map_err(|e| format!("Remove Outfit readiness record: {e}"))?;
                    if value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                        return Err(value.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown backend initialization failure").to_string());
                    }
                    let port = value.get("port").and_then(|v| v.as_u64()).filter(|v| *v > 0 && *v <= u16::MAX as u64)
                        .ok_or_else(|| "Invalid Outfit loopback port".to_string())?;
                    break port as u16;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(format!("Read Outfit readiness: {error}")),
            }
            if Instant::now() >= deadline { return Err("Bundled Outfit backend did not become ready".into()); }
            std::thread::sleep(Duration::from_millis(50));
        };
        let client = Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(120))
            .build().map_err(|e| format!("Create Outfit loopback client: {e}"))?;
        Ok(Self { process, client, port, token })
    }

    fn execute(&mut self, request: OutfitRequest) -> Result<OutfitResponse, String> {
        if let Some(exit) = self.process.exited()? { return Err(format!("Outfit runtime has exited: {exit}")); }
        let url = validated_url(self.port, &request.path)?;
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut builder = self.client.request(method, url).header("X-TT-Outfit-Token", &self.token);
        if let Some(revision) = request.recovery_revision { builder = builder.header("X-OM-Recovery-Revision", revision); }
        if let Some(body) = request.body {
            builder = builder.header("Content-Type", "application/json")
                .body(serde_json::to_vec(&body).map_err(|e| e.to_string())?);
        }
        let response = builder.send().map_err(|e| format!("Outfit loopback request failed: {e}"))?;
        let status = response.status().as_u16();
        let content_type = response.headers().get("content-type").and_then(|h| h.to_str().ok()).unwrap_or("application/octet-stream").to_string();
        let cache_control = response.headers().get("cache-control").and_then(|h| h.to_str().ok()).map(str::to_string);
        if response.content_length().is_some_and(|size| size > MAX_RESPONSE) { return Err("Outfit response exceeds 64 MiB".into()); }
        let mut bytes = Vec::new();
        response.take(MAX_RESPONSE + 1).read_to_end(&mut bytes).map_err(|e| format!("Read Outfit response: {e}"))?;
        if bytes.len() as u64 > MAX_RESPONSE { return Err("Outfit response exceeds 64 MiB".into()); }
        Ok(OutfitResponse { status, content_type, cache_control, body_base64: STANDARD.encode(bytes) })
    }
}

fn validated_url(port: u16, path: &str) -> Result<url::Url, String> {
    if !path.starts_with(PREFIX) { return Err("Outfit path is outside its namespace".into()); }
    let url = url::Url::parse(&format!("http://127.0.0.1:{port}{path}")).map_err(|e| e.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port() != Some(port) ||
        !url.username().is_empty() || url.password().is_some() || !url.path().starts_with(PREFIX) {
        return Err("Normalized Outfit URL escaped its namespace".into());
    }
    Ok(url)
}

fn private_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(format!("Not a private directory: {}", path.display())); }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)] {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(path).map_err(|e| format!("Create private Outfit directory: {e}"))?;
        }
        Err(error) => return Err(format!("Inspect private Outfit directory: {error}")),
    }
    Ok(())
}

fn bundle_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.is_empty() || relative.contains('\\') || path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("Unsafe path in the bundled Outfit runtime".into());
    }
    Ok(root.join(path))
}

fn install_bundle(parent: &Path) -> Result<PathBuf, String> {
    let destination = parent.join(OUTFIT_BUNDLE_REVISION);
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            private_directory(&destination)?;
            for &(relative, expected) in OUTFIT_BUNDLE_FILES {
                let file = bundle_path(&destination, relative)?;
                let mut cursor = destination.clone();
                for component in Path::new(relative).parent().into_iter().flat_map(Path::components) {
                    cursor.push(component);
                    private_directory(&cursor)?;
                }
                let metadata = fs::symlink_metadata(&file).map_err(|e| format!("Inspect installed Outfit runtime: {e}"))?;
                if !metadata.is_file() || metadata.file_type().is_symlink() || fs::read(&file).map_err(|e| e.to_string())? != expected {
                    return Err("Installed Outfit runtime differs from the bundle; do not execute it".into());
                }
            }
            return Ok(destination);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(format!("Inspect Outfit bundle directory: {error}")),
    }
    let stage = parent.join(format!("install-{}", Uuid::new_v4().simple()));
    private_directory(&stage)?;
    let result = (|| {
        for &(relative, bytes) in OUTFIT_BUNDLE_FILES {
            let file = bundle_path(&stage, relative)?;
            let mut cursor = stage.clone();
            for component in Path::new(relative).parent().into_iter().flat_map(Path::components) {
                cursor.push(component);
                private_directory(&cursor)?;
            }
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut handle = options.open(&file).map_err(|e| format!("Create bundled Outfit file: {e}"))?;
            handle.write_all(bytes).and_then(|_| handle.sync_all()).map_err(|e| format!("Persist bundled Outfit file: {e}"))?;
        }
        fs::rename(&stage, &destination).map_err(|e| format!("Publish Outfit runtime: {e}"))?;
        Ok(destination.clone())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&stage); }
    result
}

#[cfg(not(target_os = "android"))]
struct NodeProcess(std::process::Child);

#[cfg(not(target_os = "android"))]
impl NodeProcess {
    fn start(config: &OutfitRuntimeConfig, launcher: &Path, data: &Path, ready: &Path, token: &str) -> Result<Self, String> {
        let binary = config.node_binary.as_ref().ok_or_else(|| "No bundled Node executable for this platform".to_string())?;
        let child = std::process::Command::new(binary).arg(launcher).arg(data).arg(ready).arg(token)
            .env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
            .spawn().map_err(|e| format!("Start bundled Node runtime: {e}"))?;
        Ok(Self(child))
    }
    fn exited(&mut self) -> Result<Option<String>, String> {
        self.0.try_wait().map(|status| status.map(|s| s.to_string())).map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "android"))]
impl Drop for NodeProcess {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

#[cfg(target_os = "android")]
struct NodeProcess(Arc<std::sync::atomic::AtomicI32>);

#[cfg(target_os = "android")]
impl NodeProcess {
    fn start(_config: &OutfitRuntimeConfig, launcher: &Path, data: &Path, ready: &Path, token: &str) -> Result<Self, String> {
        use std::ffi::CString;
        use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
        static STARTED: AtomicBool = AtomicBool::new(false);
        if STARTED.swap(true, Ordering::SeqCst) { return Err("Android Node runtime cannot be initialized twice; restart the app".into()); }
        let arguments = ["node".to_string(), launcher.to_string_lossy().into_owned(), data.to_string_lossy().into_owned(), ready.to_string_lossy().into_owned(), token.to_string()];
        let arguments: Vec<CString> = arguments.into_iter().map(|arg| CString::new(arg).map_err(|e| e.to_string())).collect::<Result<_, _>>()?;
        let exit = Arc::new(AtomicI32::new(i32::MIN));
        let result = exit.clone();
        std::thread::Builder::new().name("outfit-node".into()).spawn(move || {
            unsafe extern "C" { fn tt_outfit_node_start(argc: std::ffi::c_int, argv: *const *const std::ffi::c_char) -> std::ffi::c_int; }
            let pointers: Vec<_> = arguments.iter().map(|arg| arg.as_ptr()).collect();
            // The shim copies arguments into writable contiguous storage, which
            // remains alive for the entire in-process Node event loop.
            let code = unsafe { tt_outfit_node_start(pointers.len() as _, pointers.as_ptr()) };
            result.store(code, Ordering::SeqCst);
        }).map_err(|e| format!("Start Android Node thread: {e}"))?;
        Ok(Self(exit))
    }
    fn exited(&mut self) -> Result<Option<String>, String> {
        let code = self.0.load(std::sync::atomic::Ordering::SeqCst);
        Ok((code != i32::MIN).then(|| code.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalized_paths_cannot_escape_the_plugin() {
        assert!(validated_url(12345, "/api/plugins/outfit-manager/../../../secrets").is_err());
        assert!(validated_url(12345, "/api/plugins/outfit-manager/%2e%2e/%2e%2e/settings").is_err());
        assert!(validated_url(12345, "/api/plugins/outfit-manager/partitions/user%3A__default__").is_ok());
    }
    #[test]
    fn embedded_paths_cannot_escape_the_private_directory() {
        let root = Path::new("private");
        for relative in ["../data/meta.json", "/tmp/index.js", "node_modules/../../data", "a\\b", ""] {
            assert!(bundle_path(root, relative).is_err());
        }
        assert_eq!(bundle_path(root, "server/index.js").unwrap(), root.join("server/index.js"));
    }
}
