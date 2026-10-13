use std::sync::Arc;
use tokio::sync::Semaphore;
use tt_contracts::outfit::{OutfitRequest, OutfitResponse};
use tt_domain::errors::DomainError;
use tt_ports::outfit::OutfitBackend;

const PREFIX: &str = "/api/plugins/outfit-manager/";
const MAX_BODY: usize = 64 * 1024 * 1024;

pub struct OutfitService {
    backend: Arc<dyn OutfitBackend>,
    permits: Semaphore,
}

impl OutfitService {
    pub fn new(backend: Arc<dyn OutfitBackend>) -> Self {
        Self { backend, permits: Semaphore::new(8) }
    }

    pub async fn execute(&self, request: OutfitRequest) -> Result<OutfitResponse, DomainError> {
        validate(&request)?;
        let _permit = self.permits.try_acquire().map_err(|_| DomainError::rate_limited("Outfit backend is busy"))?;
        self.backend.execute(request).await
    }
}

fn validate(request: &OutfitRequest) -> Result<(), DomainError> {
    if !matches!(request.method.as_str(), "GET" | "HEAD" | "POST" | "PUT" | "DELETE") {
        return Err(DomainError::InvalidData("Unsupported Outfit method".into()));
    }
    if !request.path.starts_with(PREFIX) || request.path.len() > 2048 ||
        request.path.chars().any(|c| c.is_control() || c == '\\' || c == '#') {
        return Err(DomainError::InvalidData("Outfit endpoint is outside the allowed namespace".into()));
    }
    if let Some(revision) = &request.recovery_revision {
        if revision.len() > 128 || !revision.is_ascii() || revision.bytes().any(|c| c.is_ascii_control()) {
            return Err(DomainError::InvalidData("Invalid Outfit recovery revision".into()));
        }
    }
    if let Some(body) = &request.body {
        if matches!(request.method.as_str(), "GET" | "HEAD") {
            return Err(DomainError::InvalidData("Read requests cannot contain an Outfit mutation body".into()));
        }
        let bytes = serde_json::to_vec(body).map_err(|e| DomainError::InvalidData(e.to_string()))?;
        if bytes.len() > MAX_BODY {
            return Err(DomainError::InvalidData("Outfit request exceeds the 64 MiB limit".into()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read_request(path: &str) -> OutfitRequest {
        OutfitRequest { method: "GET".into(), path: path.into(), body: None, recovery_revision: None }
    }

    #[test]
    fn rejects_other_plugin_namespaces_and_header_injection() {
        assert!(validate(&read_request("/api/plugins/outfit-manager-other/data")).is_err());
        assert!(validate(&read_request("https://example.com/api/plugins/outfit-manager/data")).is_err());
        let mut request = read_request("/api/plugins/outfit-manager/status");
        request.recovery_revision = Some("revision\r\nX-Injected: value".into());
        assert!(validate(&request).is_err());
    }

    #[test]
    fn accepts_partition_mutations_but_not_read_requests_with_bodies() {
        let mut request = read_request("/api/plugins/outfit-manager/partitions/user%3A__default__");
        request.body = Some(json!({"outfits": [], "categories": [], "activeIds": []}));
        assert!(validate(&request).is_err());
        request.method = "PUT".into();
        assert!(validate(&request).is_ok());
    }
}
