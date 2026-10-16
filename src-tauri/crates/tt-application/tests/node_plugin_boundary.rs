use async_trait::async_trait;
use std::sync::Arc;
use tt_application::services::node_plugin_service::NodePluginService;
use tt_contracts::node_plugins::{PluginHostStatus, PluginRequest, PluginResponse};
use tt_domain::errors::DomainError;
use tt_ports::node_plugins::NodePluginRuntime;

struct UnreachableRuntime;
#[async_trait]
impl NodePluginRuntime for UnreachableRuntime {
    async fn status(&self) -> Result<PluginHostStatus, DomainError> {
        unreachable!()
    }
    async fn start(&self) -> Result<PluginHostStatus, DomainError> {
        unreachable!()
    }
    async fn stop(&self) -> Result<PluginHostStatus, DomainError> {
        unreachable!()
    }
    async fn request(&self, _: PluginRequest) -> Result<PluginResponse, DomainError> {
        panic!("invalid request reached Node")
    }
}

#[tokio::test]
async fn browser_cannot_reach_private_host_routes_or_escape_plugin_prefix() {
    let service = NodePluginService::new(Arc::new(UnreachableRuntime));
    for path in [
        "/_tt/shutdown",
        "http://elsewhere/api/plugins/test",
        "//elsewhere/api/plugins/test",
        "/api/plugins/test/../../../_tt/shutdown",
        "/api/plugins/test/%2e%2e/%2e%2e/%2e%2e/_tt/shutdown",
        "/api/plugins/test/..\\..\\_tt/shutdown",
        "/api/plugins//status",
        "/api/plugins/test/status#fragment",
    ] {
        assert!(
            matches!(
                service
                    .request(PluginRequest {
                        method: "POST".into(),
                        path: path.into(),
                        headers: Default::default(),
                        body: vec![],
                    })
                    .await,
                Err(DomainError::InvalidData(_))
            ),
            "{path}"
        );
    }
}
