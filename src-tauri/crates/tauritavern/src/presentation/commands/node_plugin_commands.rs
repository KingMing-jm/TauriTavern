use crate::{app::AppState, presentation::errors::CommandError};
use std::sync::Arc;
use tauri::State;
use tt_contracts::node_plugins::{PluginHostStatus, PluginRequest, PluginResponse};

#[tauri::command]
pub async fn node_plugin_status(
    app_state: State<'_, Arc<AppState>>,
) -> Result<PluginHostStatus, CommandError> {
    app_state
        .services
        .node_plugin_service
        .status()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn start_node_plugins(
    app_state: State<'_, Arc<AppState>>,
) -> Result<PluginHostStatus, CommandError> {
    app_state
        .services
        .node_plugin_service
        .start()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn stop_node_plugins(
    app_state: State<'_, Arc<AppState>>,
) -> Result<PluginHostStatus, CommandError> {
    app_state
        .services
        .node_plugin_service
        .stop()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn node_plugin_request(
    request: PluginRequest,
    app_state: State<'_, Arc<AppState>>,
) -> Result<PluginResponse, CommandError> {
    app_state
        .services
        .node_plugin_service
        .request(request)
        .await
        .map_err(Into::into)
}
