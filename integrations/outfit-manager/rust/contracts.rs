use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutfitRequest {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
    pub recovery_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutfitResponse {
    pub status: u16,
    pub content_type: String,
    pub cache_control: Option<String>,
    pub body_base64: String,
}
