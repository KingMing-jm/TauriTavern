use base64::{Engine as _, engine::general_purpose::STANDARD};
use tauri::Manager;
use tt_contracts::outfit::{OutfitRequest, OutfitResponse};
use crate::app::composition::outfit::{self, OutfitState};
use crate::presentation::errors::CommandError;

#[tauri::command]
async fn request<R: tauri::Runtime>(app: tauri::AppHandle<R>, request: OutfitRequest) -> Result<OutfitResponse, CommandError> {
    Ok(outfit::service(&app).await?.execute(request).await?)
}

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("outfit")
        .invoke_handler(tauri::generate_handler![request])
        .setup(|app, _api| { app.manage(OutfitState::default()); Ok(()) })
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<OutfitState>() { state.shutdown(); }
            }
        })
        .build()
}

fn error_response(status: u16, message: &str) -> tauri::http::Response<Vec<u8>> {
    let mut response = tauri::http::Response::new(message.as_bytes().to_vec());
    *response.status_mut() = tauri::http::StatusCode::from_u16(status).unwrap_or(tauri::http::StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert("access-control-allow-origin", tauri::http::HeaderValue::from_static("*"));
    response
}

fn valid_image_name(name: &str) -> bool {
    let Some((hash, extension)) = name.rsplit_once('.') else { return false; };
    hash.len() == 40 && hash.bytes().all(|c| c.is_ascii_hexdigit()) &&
        matches!(extension, "jpg" | "png" | "webp" | "gif" | "bmp")
}

pub async fn image_response<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>, request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let head = request.method() == tauri::http::Method::HEAD;
    if !head && request.method() != tauri::http::Method::GET { return error_response(405, "Method not allowed"); }
    let decoded = match percent_encoding::percent_decode_str(request.uri().path()).decode_utf8() {
        Ok(path) => path,
        Err(_) => return error_response(400, "Invalid image path"),
    };
    let Some(name) = decoded.trim_start_matches('/').strip_prefix("images/") else { return error_response(404, "Unknown image route"); };
    if !valid_image_name(name) { return error_response(400, "Invalid image name"); }
    let service = match outfit::service(app).await {
        Ok(service) => service,
        Err(error) => { tracing::warn!("Outfit image service unavailable: {error}"); return error_response(503, "Outfit image service unavailable"); }
    };
    let result = service.execute(OutfitRequest {
        method: "GET".into(),
        path: format!("/api/plugins/outfit-manager/images/{name}"),
        body: None,
        recovery_revision: None,
    }).await;
    match result {
        Ok(result) => {
            let bytes = match STANDARD.decode(result.body_base64) {
                Ok(bytes) => bytes,
                Err(_) => return error_response(502, "Invalid native image response"),
            };
            let mut builder = tauri::http::Response::builder().status(result.status)
                .header("Content-Type", result.content_type)
                .header("Access-Control-Allow-Origin", "*")
                .header("X-Content-Type-Options", "nosniff");
            if let Some(cache) = result.cache_control { builder = builder.header("Cache-Control", cache); }
            builder.body(if head { Vec::new() } else { bytes }).unwrap_or_else(|_| error_response(502, "Invalid image response headers"))
        }
        Err(error) => {
            tracing::warn!("Outfit image request failed: {error}");
            error_response(503, "Outfit image service unavailable")
        }
    }
}
