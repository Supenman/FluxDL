use fluxdl_engine::{Engine, EngineOptions, EngineInfo, NewTaskOptions, TaskKind, TaskView};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

struct AppState {
    engine: Arc<Engine>,
    clipboard_enabled: Arc<AtomicBool>,
}

#[derive(Serialize)]
struct AddResult {
    tasks: Vec<TaskView>,
    errors: Vec<String>,
}

#[tauri::command]
async fn get_tasks(state: State<'_, AppState>) -> Result<Vec<TaskView>, String> {
    Ok(state.engine.tasks().await)
}

#[tauri::command]
async fn add_tasks(
    state: State<'_, AppState>,
    urls: Vec<String>,
    kind: Option<String>,
    options: NewTaskOptions,
) -> Result<AddResult, String> {
    let kind = match kind.as_deref() {
        Some("media") => TaskKind::Media,
        _ => TaskKind::Http,
    };
    let mut tasks = Vec::new();
    let mut errors = Vec::new();
    for url in urls {
        let url = url.trim().to_string();
        if url.is_empty() {
            continue;
        }
        match state.engine.add(kind, &url, options.clone()).await {
            Ok(task) => tasks.push(task),
            Err(err) => errors.push(format!("{url}：{err}")),
        }
    }
    Ok(AddResult { tasks, errors })
}

#[tauri::command]
async fn pause_task(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.pause(&id).await;
    Ok(())
}

#[tauri::command]
async fn resume_task(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.resume(&id).await;
    Ok(())
}

#[tauri::command]
async fn retry_task(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.retry(&id).await;
    Ok(())
}

#[tauri::command]
async fn remove_task(
    state: State<'_, AppState>,
    id: String,
    delete_file: bool,
) -> Result<(), String> {
    state.engine.remove(&id, delete_file).await;
    Ok(())
}

#[tauri::command]
async fn pause_all(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.pause_all().await;
    Ok(())
}

#[tauri::command]
async fn resume_all(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.resume_all().await;
    Ok(())
}

#[tauri::command]
async fn set_task_speed_limit(
    state: State<'_, AppState>,
    id: String,
    limit: Option<u64>,
) -> Result<(), String> {
    state.engine.set_speed_limit(&id, limit).await;
    Ok(())
}

#[tauri::command]
async fn get_engine_options(state: State<'_, AppState>) -> Result<EngineOptions, String> {
    Ok(state.engine.options())
}

#[tauri::command]
async fn set_engine_options(
    state: State<'_, AppState>,
    options: EngineOptions,
) -> Result<EngineOptions, String> {
    let mut options = options;
    options.max_active = options.max_active.clamp(1, 12);
    options.connections = options.connections.clamp(1, 32);
    if options.save_dir.trim().is_empty() {
        return Err("默认保存目录不能为空".into());
    }
    state.engine.set_options(options.clone()).await;
    state
        .clipboard_enabled
        .store(options.clipboard_watch, Ordering::Relaxed);
    Ok(options)
}

#[tauri::command]
async fn set_clipboard_watch(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state.clipboard_enabled.store(enabled, Ordering::Relaxed);
    let mut options = state.engine.options();
    if options.clipboard_watch != enabled {
        options.clipboard_watch = enabled;
        state.engine.set_options(options).await;
    }
    Ok(())
}

#[tauri::command]
async fn engine_info(state: State<'_, AppState>) -> Result<EngineInfo, String> {
    let options = state.engine.options();
    let yt_dlp_available = probe_binary(&options.yt_dlp_path, &["--version"]).await;
    let ffmpeg_cmd = options
        .ffmpeg_path
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "ffmpeg".into());
    let ffmpeg_available = probe_binary(&ffmpeg_cmd, &["-version"]).await;
    Ok(EngineInfo {
        version: fluxdl_engine::ENGINE_VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        yt_dlp_path: options.yt_dlp_path,
        yt_dlp_available,
        ffmpeg_available,
    })
}

async fn probe_binary(binary: &str, args: &[&str]) -> bool {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(6), cmd.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

#[tauri::command]
async fn pick_folder(default_path: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(path) = default_path.filter(|p| !p.trim().is_empty()) {
            dialog = dialog.set_directory(path);
        }
        dialog
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn pick_file(default_path: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(path) = default_path.filter(|p| !p.trim().is_empty()) {
            if let Some(parent) = std::path::Path::new(&path).parent() {
                dialog = dialog.set_directory(parent);
            }
        }
        dialog.pick_file().map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    if path.is_dir() {
        opener::open(path).map_err(|e| e.to_string())
    } else if let Some(parent) = path.parent() {
        opener::open(parent).map_err(|e| e.to_string())
    } else {
        opener::open(path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    opener::open(path).map_err(|e| e.to_string())
}

fn extension_dir(app: &AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let dir = resource_dir.join("browser-extension");
        if dir.exists() {
            return dir;
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../browser-extension");
        if dev.exists() {
            return dev;
        }
    }
    PathBuf::from(".")
}

#[tauri::command]
fn open_extension_folder(app: AppHandle) -> Result<(), String> {
    let dir = extension_dir(&app);
    if !dir.exists() {
        return Err("未找到浏览器扩展目录，请重新安装 FluxDL".into());
    }
    opener::open(&dir).map_err(|e| e.to_string())
}

const CAPTURE_PORT: u16 = 35917;
const CAPTURE_TOKEN: &str = "fluxdl-local-v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRequest {
    url: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    referer: Option<String>,
    #[serde(default)]
    user_agent: Option<String>,
    #[serde(default)]
    kind: Option<String>,
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut TcpStream) -> Option<HttpRequest> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 1 << 20 {
            return None;
        }
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?.to_string();
    let path = request_line.next()?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0)
        .min(256 * 1024);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);

    Some(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

async fn write_http_response(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let payload = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: content-type, x-fluxdl-token\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n{body}",
        len = body.len(),
    );
    let _ = stream.write_all(payload.as_bytes()).await;
    let _ = stream.flush().await;
}

fn looks_like_media(url: &str) -> bool {
    let lowered = url.to_ascii_lowercase();
    const HOSTS: &[&str] = &[
        "youtube.com",
        "youtu.be",
        "bilibili.com",
        "b23.tv",
        "twitter.com",
        "x.com",
        "instagram.com",
        "vimeo.com",
        "tiktok.com",
        "douyin.com",
        "soundcloud.com",
        "facebook.com",
        "twitch.tv",
        "dailymotion.com",
        "nicovideo.jp",
        "iqiyi.com",
        "youku.com",
        "weibo.com",
        "xiaohongshu.com",
        "music.163.com",
    ];
    HOSTS.iter().any(|host| lowered.contains(host))
}

async fn handle_capture_conn(mut stream: TcpStream, engine: Arc<Engine>) {
    let Some(request) = read_http_request(&mut stream).await else {
        return;
    };

    if request.method == "OPTIONS" {
        write_http_response(&mut stream, 204, "No Content", "").await;
        return;
    }

    let path = request
        .path
        .split('?')
        .next()
        .unwrap_or("/")
        .trim_end_matches('/')
        .to_string();

    if path == "/api/health" {
        let body = serde_json::json!({
            "ok": true,
            "app": "FluxDL",
            "version": fluxdl_engine::ENGINE_VERSION,
            "port": CAPTURE_PORT,
        });
        write_http_response(&mut stream, 200, "OK", &body.to_string()).await;
        return;
    }

    let authorized = request
        .headers
        .get("x-fluxdl-token")
        .map(|token| token == CAPTURE_TOKEN)
        .unwrap_or(false);
    if !authorized {
        write_http_response(
            &mut stream,
            401,
            "Unauthorized",
            r#"{"ok":false,"error":"扩展令牌无效"}"#,
        )
        .await;
        return;
    }

    if request.method != "POST" || path != "/api/downloads" {
        write_http_response(
            &mut stream,
            404,
            "Not Found",
            r#"{"ok":false,"error":"接口不存在"}"#,
        )
        .await;
        return;
    }

    let payload = match serde_json::from_slice::<CaptureRequest>(&request.body) {
        Ok(payload) => payload,
        Err(err) => {
            let body = serde_json::json!({
                "ok": false,
                "error": format!("请求格式不正确：{err}"),
            });
            write_http_response(&mut stream, 400, "Bad Request", &body.to_string()).await;
            return;
        }
    };

    let url = payload.url.trim().to_string();
    if url.is_empty() {
        let body = serde_json::json!({ "ok": false, "error": "链接不能为空" });
        write_http_response(&mut stream, 400, "Bad Request", &body.to_string()).await;
        return;
    }

    let kind = match payload.kind.as_deref() {
        Some("media") => TaskKind::Media,
        Some("http") => TaskKind::Http,
        _ if looks_like_media(&url) => TaskKind::Media,
        _ => TaskKind::Http,
    };

    let options = NewTaskOptions {
        filename: payload.filename,
        prefer_header_filename: true,
        referer: payload.referer,
        user_agent: payload.user_agent,
        ..Default::default()
    };

    match engine.add(kind, &url, options).await {
        Ok(task) => {
            let task_id = task.id.clone();
            let body = serde_json::json!({ "ok": true, "id": task_id, "task": task });
            write_http_response(&mut stream, 200, "OK", &body.to_string()).await;
        }
        Err(err) => {
            let body = serde_json::json!({ "ok": false, "error": err.to_string() });
            write_http_response(&mut stream, 400, "Bad Request", &body.to_string()).await;
        }
    }
}

fn start_capture_server(engine: Arc<Engine>) {
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", CAPTURE_PORT)).await {
            Ok(listener) => listener,
            Err(_) => return,
        };
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let engine = engine.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_capture_conn(stream, engine).await;
                    });
                }
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause_all", "全部暂停", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume_all", "全部继续", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 FluxDL", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &pause,
            &resume,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("fluxdl-tray")
        .tooltip("FluxDL · 迅流下载器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "pause_all" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<AppState>().engine.pause_all().await;
                });
            }
            "resume_all" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<AppState>().engine.resume_all().await;
                });
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn start_clipboard_watcher(app: AppHandle, enabled: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut clipboard = arboard::Clipboard::new().ok();
        let mut last = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(600));
            if !enabled.load(Ordering::Relaxed) {
                continue;
            }
            if clipboard.is_none() {
                clipboard = arboard::Clipboard::new().ok();
                if clipboard.is_none() {
                    continue;
                }
            }
            let Some(cb) = clipboard.as_mut() else { continue };
            let Ok(text) = cb.get_text() else { continue };
            let text = text.trim().to_string();
            if text.is_empty() || text.len() > 2048 {
                continue;
            }
            let looks_like_url = (text.starts_with("http://") || text.starts_with("https://"))
                && !text.contains('\n')
                && !text.contains(' ');
            if looks_like_url && text != last {
                last = text.clone();
                let _ = app.emit("clipboard:url", text);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let _ = std::fs::create_dir_all(&data_dir);

            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            // Engine::new spawns its 500 ms progress ticker, so it must run
            // inside the Tokio runtime context.
            let engine = tauri::async_runtime::block_on(async move {
                Engine::new(data_dir.join("tasks.json"), tx)
            });
            let clipboard_enabled = Arc::new(AtomicBool::new(
                engine.options().clipboard_watch,
            ));

            let capture_engine = engine.clone();
            app.manage(AppState {
                engine,
                clipboard_enabled: clipboard_enabled.clone(),
            });
            start_capture_server(capture_engine);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    let _ = handle.emit("engine:event", &event);
                }
            });

            start_clipboard_watcher(app.handle().clone(), clipboard_enabled);
            build_tray(app.handle())?;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<AppState>().engine.options().close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_tasks,
            add_tasks,
            pause_task,
            resume_task,
            retry_task,
            remove_task,
            pause_all,
            resume_all,
            set_task_speed_limit,
            get_engine_options,
            set_engine_options,
            set_clipboard_watch,
            engine_info,
            pick_folder,
            pick_file,
            open_path,
            open_file,
            open_extension_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building FluxDL")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let engine = app.state::<AppState>().engine.clone();
                tauri::async_runtime::block_on(engine.save());
            }
        });
}
