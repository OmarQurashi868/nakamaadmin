use std::collections::HashMap;
use std::io::Write;
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
fn select_files() -> Result<Option<Vec<String>>, String> {
    let files = rfd::FileDialog::new()
        .pick_files();

    Ok(files.map(|paths| paths.iter().map(|p| p.to_string_lossy().into_owned()).collect()))
}

#[tauri::command]
fn select_folder() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .pick_folder();

    Ok(folder.map(|p| p.to_string_lossy().into_owned()))
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
        "PATCH"  => client.patch(&url),
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
fn select_save_path(default_name: String) -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .save_file();

    Ok(file.map(|p| p.to_string_lossy().into_owned()))
}

fn walk_dir(dir: &Path, base: &Path, out: &mut Vec<(String, String)>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_dir(&path, base, out);
        } else if path.is_file() {
            let rel = path.strip_prefix(base).unwrap_or(&path);
            let zip_path = rel.to_string_lossy().replace('\\', "/");
            out.push((zip_path, path.to_string_lossy().into_owned()));
        }
    }
}

fn collect_paths(roots: &[String]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for root in roots {
        let p = Path::new(root);
        if p.is_dir() {
            walk_dir(p, p, &mut out);
        } else {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "unknown".to_string());
            out.push((name, root.clone()));
        }
    }
    out
}

#[tauri::command]
async fn create_temp_zip(roots: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let temp_dir = std::env::temp_dir();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let temp_path = temp_dir.join(format!("nakama_upload_{}.zip", ts));

        let entries = collect_paths(&roots);

        let cursor = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        // Stored = no compression, fastest for already-compressed game assets
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        for (zip_path, fs_path) in &entries {
            zip.start_file(zip_path, options)
                .map_err(|e| format!("Failed to add '{}': {}", zip_path, e))?;

            let data = std::fs::read(fs_path)
                .map_err(|e| format!("Failed to read '{}': {}", fs_path, e))?;

            zip.write_all(&data)
                .map_err(|e| format!("Failed to write '{}': {}", fs_path, e))?;
        }

        let cursor = zip.finish().map_err(|e| format!("Failed to finalize zip: {}", e))?;
        let data = cursor.into_inner();
        std::fs::write(&temp_path, &data)
            .map_err(|e| format!("Failed to write temp zip: {}", e))?;

        Ok(temp_path.to_string_lossy().into_owned())
    }).await.map_err(|e| format!("Zip task panicked: {}", e))?
}

#[tauri::command]
fn delete_temp_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete temp file: {}", e))
}

#[tauri::command]
async fn download_file(
    url: String,
    api_key: String,
    save_path: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("X-API-Key", &api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(&save_path, &bytes).await.map_err(|e| e.to_string())?;
    Ok("ok".to_string())
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
    app_id: String,
    notes: String,
    title_notes: String,
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
        .text("app_id", app_id)
        .text("notes", notes)
        .text("title_notes", title_notes)
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
    notes: String,
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
        .text("notes", notes)
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
            select_files,
            select_folder,
            select_save_path,
            create_temp_zip,
            delete_temp_file,
            server_request,
            cancel_upload,
            upload_game,
            upload_modpack,
            download_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_temp_zip() {
        // Create two tiny temp files
        let dir = std::env::temp_dir();
        let f1 = dir.join("__nakama_test_a.txt");
        let f2 = dir.join("__nakama_test_b.txt");
        std::fs::write(&f1, b"hello world").unwrap();
        std::fs::write(&f2, b"foo bar baz").unwrap();

        let files = vec![
            f1.to_string_lossy().into_owned(),
            f2.to_string_lossy().into_owned(),
        ];

        let zip_path = create_temp_zip(files).await.expect("create_temp_zip failed");
        let zip_bytes = std::fs::read(&zip_path).expect("failed to read zip");
        assert!(zip_bytes.len() > 100, "zip too small: {} bytes", zip_bytes.len());

        // Verify we can read it back
        let reader = std::io::Cursor::new(&zip_bytes);
        let mut archive = zip::ZipArchive::new(reader).expect("failed to open zip");
        assert_eq!(archive.len(), 2, "expected 2 files, got {}", archive.len());

        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.contains(&"__nakama_test_a.txt".to_string()));
        assert!(names.contains(&"__nakama_test_b.txt".to_string()));

        // Cleanup
        std::fs::remove_file(&zip_path).ok();
        std::fs::remove_file(&f1).ok();
        std::fs::remove_file(&f2).ok();
    }
}
