use async_trait::async_trait;
use tt_contracts::node_plugins::{PluginHostStatus, PluginRequest, PluginResponse};
use tt_domain::errors::DomainError;

#[async_trait]
pub trait NodePluginRuntime: Send + Sync {
    async fn status(&self) -> Result<PluginHostStatus, DomainError>;
    async fn start(&self) -> Result<PluginHostStatus, DomainError>;
    async fn stop(&self) -> Result<PluginHostStatus, DomainError>;
    async fn request(&self, request: PluginRequest) -> Result<PluginResponse, DomainError>;
}
