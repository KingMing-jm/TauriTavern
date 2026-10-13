use async_trait::async_trait;
use tt_contracts::outfit::{OutfitRequest, OutfitResponse};
use tt_domain::errors::DomainError;

#[async_trait]
pub trait OutfitBackend: Send + Sync {
    async fn execute(&self, request: OutfitRequest) -> Result<OutfitResponse, DomainError>;
}
