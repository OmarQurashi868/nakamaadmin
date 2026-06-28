use std::path::Path;

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
        "GET" => client.get(&url),
        "DELETE" => client.delete(&url),
        "POST" => client.post(&url),
        _ => return Err(format!("Unsupported method: {}", method)),
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
async fn upload_game(
    server_url: String,
    admin_key: String,
    title: String,
    version: String,
    launch_exe: String,
    file_path: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    let file_name = Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file.zip".to_string());

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("application/zip")
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .text("title", title)
        .text("version", version)
        .text("launch_exe", launch_exe)
        .part("file", part);

    let url = format!("{}/admin/upload/game", server_url.trim_end_matches('/'));

    let res = client
        .post(&url)
        .header("X-API-Key", &admin_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

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
    server_url: String,
    admin_key: String,
    game_title: String,
    modpack_title: String,
    file_path: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    let file_name = Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file.zip".to_string());

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("application/zip")
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .text("game_title", game_title)
        .text("modpack_title", modpack_title)
        .part("file", part);

    let url = format!("{}/admin/upload/modpack", server_url.trim_end_matches('/'));

    let res = client
        .post(&url)
        .header("X-API-Key", &admin_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

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
        .invoke_handler(tauri::generate_handler![
            select_zip_file,
            server_request,
            upload_game,
            upload_modpack
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
