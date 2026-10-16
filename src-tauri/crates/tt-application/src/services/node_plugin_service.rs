use std::sync::Arc;
use tt_contracts::node_plugins::{PluginHostStatus, PluginRequest, PluginResponse};
use tt_domain::errors::DomainError;
use tt_ports::node_plugins::NodePluginRuntime;

pub struct NodePluginService {
    runtime: Arc<dyn NodePluginRuntime>,
}

impl NodePluginService {
    pub fn new(runtime: Arc<dyn NodePluginRuntime>) -> Self {
        Self { runtime }
    }
    pub async fn status(&self) -> Result<PluginHostStatus, DomainError> {
        self.runtime.status().await
    }
    pub async fn start(&self) -> Result<PluginHostStatus, DomainError> {
        self.runtime.start().await
    }
    pub async fn stop(&self) -> Result<PluginHostStatus, DomainError> {
        self.runtime.stop().await
    }

    pub async fn request(&self, request: PluginRequest) -> Result<PluginResponse, DomainError> {
        // The browser can address plugin routes only, never the private host API.
        let url = url::Url::parse(&format!("http://localhost{}", request.path))
            .map_err(|e| DomainError::InvalidData(format!("Plugin URL: {e}")))?;
        let route = url.path().strip_prefix("/api/plugins/");
        if !request.path.starts_with("/api/plugins/")
            || url.host_str() != Some("localhost")
            || url.fragment().is_some()
            || route.is_none_or(|r| {
                r.split('/').next().is_none_or(|id| {
                    id.is_empty()
                        || !id.bytes().all(|b| {
                            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'
                        })
                })
            })
            || request.path.contains(['\\', '\r', '\n'])
            || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
                .contains(&request.method.as_str())
            || request.body.len() > 8 * 1024 * 1024
        {
            return Err(DomainError::InvalidData(
                "Invalid backend plugin request".into(),
            ));
        }
        self.runtime.request(request).await
    }
}
