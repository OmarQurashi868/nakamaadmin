use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use reqwest::Body;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

// ─── UPLOAD REGISTRY ────────────────────────────────────
// Maps upload_id -> cancellation flag. Stored as Tauri managed state.
struct UploadRegistry(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl UploadRegistry {
    fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.0.lock() {
            map.insert(id.to_string(), Arc::clone(&flag));
        }
        flag
    }

    fn cancel(&self, id: &str) {
        if let Ok(map) = self.0.lock() {
            if let Some(flag) = map.get(id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    fn remove(&self, id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(id);
        }
    }
}

// ─── PROGRESS EVENT ─────────────────────────────────────

#[derive(Clone, Serialize)]
struct UploadProgress {
    id: String,
    sent: u64,
    total: u64,
}

/// Wraps a byte vec into a streaming Body, emitting progress events per 64 KiB
/// chunk and aborting early if the cancellation flag is set.
fn progress_body(
    app: AppHandle,
    id: String,
    data: Vec<u8>,
    cancelled: Arc<AtomicBool>,
) -> Body {
    let total = data.len() as u64;
    let sent = Arc::new(Mutex::new(0u64));
    let app = Arc::new(app);
    let id = Arc::new(id);

    // Emit 0% immediately so the tray shows something right away
    let _ = app.emit(
        "upload://progress",
        UploadProgress { id: (*id).clone(), sent: 0, total },
    );

    const CHUNK: usize = 65536; // 64 KiB
    let chunks: Vec<Vec<u8>> = data.chunks(CHUNK).map(|c| c.to_vec()).collect();

    let stream = async_stream::stream! {
        for chunk in chunks {
            // Check cancellation before every chunk
            if cancelled.load(Ordering::Relaxed) {
                yield Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "upload cancelled",
                ));
                return;
            }
            let n = chunk.len() as u64;
            yield Ok::<_, std::io::Error>(bytes::Bytes::from(chunk));
            let mut s = sent.lock().unwrap();
            *s += n;
            let _ = app.emit(
                "upload://progress",
                UploadProgress { id: (*id).clone(), sent: *s, total },
            );
        }
    };

    Body::wrap_stream(stream)
}

// ─── COMMANDS ────────────────────────────────────────────

#[tauri::command]
fn select_zip_file() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new()
        .add_filter("Zip Files", &["zip"])
        .pick_file();

    Ok(file.map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn server_request(
    method: String,
    url: String,
    api_key: String,
    body: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut req = match method.to_uppercase().as_str() {
        "GET"    => client.get(&url),
        "DELETE" => client.delete(&url),
        "POST"   => client.post(&url),
        _        => return Err(format!("Unsupported method: {}", method)),
    };

    req = req.header("X-API-Key", &api_key);

    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").body(b);
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;

    if status.is_success() {
        Ok(text)
    } else {
        Err(format!("HTTP {}: {}", status, text))
    }
}

#[tauri::command]
fn cancel_upload(
    state: tauri::State<UploadRegistry>,
    upload_id: String,
) -> Result<(), String> {
    state.cancel(&upload_id);
    Ok(())
}

#[tauri::command]
async fn upload_game(
    app: AppHandle,
    state: tauri::State<'_, UploadRegistry>,
    server_url: String,
    admin_key: String,
    title: String,
    version: String,
    launch_exe: String,
    file_path: String,
    upload_id: String,
) -> Result<String, String> {
    let cancelled = state.register(&upload_id);

    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let file_name = Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file.zip".to_string());

    let total = file_bytes.len() as u64;
    let body_stream = progress_body(app, upload_id.clone(), file_bytes, cancelled);

    let part = reqwest::multipart::Part::stream_with_length(body_stream, total)
        .file_name(file_name)
        .mime_str("application/zip")
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .text("title", title)
        .text("version", version)
        .text("launch_exe", launch_exe)
        .part("file", part);

    let url = format!("{}/admin/upload/game", server_url.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let result = client
        .post(&url)
        .header("X-API-Key", &admin_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string());

    state.remove(&upload_id);

    let res = result?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;

    if status.is_success() {
        Ok(text)
    } else {
        Err(format!("HTTP {}: {}", status, text))
    }
}

#[tauri::command]
async fn upload_modpack(
    app: AppHandle,
    state: tauri::State<'_, UploadRegistry>,
    server_url: String,
    admin_key: String,
    game_title: String,
    modpack_title: String,
    file_path: String,
    upload_id: String,
) -> Result<String, String> {
    let cancelled = state.register(&upload_id);

    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let file_name = Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file.zip".to_string());

    let total = file_bytes.len() as u64;
    let body_stream = progress_body(app, upload_id.clone(), file_bytes, cancelled);

    let part = reqwest::multipart::Part::stream_with_length(body_stream, total)
        .file_name(file_name)
        .mime_str("application/zip")
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .text("game_title", game_title)
        .text("modpack_title", modpack_title)
        .part("file", part);

    let url = format!("{}/admin/upload/modpack", server_url.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let result = client
        .post(&url)
        .header("X-API-Key", &admin_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string());

    state.remove(&upload_id);

    let res = result?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;

    if status.is_success() {
        Ok(text)
    } else {
        Err(format!("HTTP {}: {}", status, text))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(UploadRegistry(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            select_zip_file,
            server_request,
            cancel_upload,
            upload_game,
            upload_modpack
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
