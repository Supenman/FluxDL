use fluxdl_engine::{Engine, EngineOptions, EngineInfo, NewTaskOptions, TaskKind, TaskView};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

mod appversion;
mod capture_guard;
mod tools;
mod version;
use capture_guard::CAPTURE_PORT;

struct AppState {
    engine: Arc<Engine>,
    clipboard_enabled: Arc<AtomicBool>,
}

#[derive(Serialize)]
struct AddResult {
    tasks: Vec<TaskView>,
    errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskListSnapshot {
    tasks: Vec<TaskView>,
    recovered_from_backup: bool,
}

#[tauri::command]
async fn get_tasks(state: State<'_, AppState>) -> Result<TaskListSnapshot, String> {
    Ok(TaskListSnapshot {
        tasks: state.engine.tasks().await,
        recovered_from_backup: state.engine.recovered_tasks(),
    })
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
    // 手动新建 / 批量导入 / 剪贴板确认由用户主动发起，不再强制二次审核。
    let mut options = options;
    options.require_approval = false;
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
async fn update_task_url(
    state: State<'_, AppState>,
    id: String,
    new_url: String,
    auto_resume: bool,
) -> Result<TaskView, String> {
    state
        .engine
        .update_task_url(&id, new_url, auto_resume)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn verify_task_checksum(
    state: State<'_, AppState>,
    id: String,
    expected: String,
) -> Result<fluxdl_engine::verify::ChecksumVerification, String> {
    state
        .engine
        .verify_task_checksum(&id, expected)
        .await
        .map_err(|e| e.to_string())
}

/// 审核通过：批准单条待审核下载并启动。
#[tauri::command]
async fn approve_task(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.approve(&id).await;
    Ok(())
}

/// 审核通过：批准当前全部待审核下载。
#[tauri::command]
async fn approve_all_tasks(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.approve_all().await;
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

// ---------------------------------------------------------------------------
// 开机自启（仅 NSIS 安装版）
// ---------------------------------------------------------------------------

/// NSIS 安装版一定会在 exe 同级放一个 `uninstall.exe`；便携版解压目录和
/// 「单独一个 exe」都没有。用这个做安装版判据，而不是 `tools/` 目录：
/// 安装版资源里也带 tools/，用它判断会把安装版误认成便携版。
/// 抽成纯函数，便于单测锁死这条契约。
fn has_install_marker(exe: &Path) -> bool {
    exe.parent()
        .map(|dir| dir.join("uninstall.exe").is_file())
        .unwrap_or(false)
}

/// 前端据此决定是否显示「开机自启」开关。
///
/// 便携版必须隐藏：绿软的核心承诺是「删掉文件夹就等于卸载」，
/// 一旦往注册表写自启项，文件夹删了还会残留一个指向空路径的启动项。
/// 默认关闭也由此保证——我们从不主动调 enable，注册表里就不会有这一项。
#[tauri::command]
fn autostart_available() -> bool {
    let installed = std::env::current_exe()
        .map(|exe| has_install_marker(&exe))
        .unwrap_or(false);
    // 目前只出 Windows 包；非 Windows 编译态（CI / 本地 Linux）一律不提供。
    cfg!(windows) && installed
}

/// 读取当前自启状态。插件把状态存在系统里（Windows 是 HKCU Run 项），
/// 重启应用后仍然有效，不需要我们额外落盘。
#[tauri::command]
fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    if !autostart_available() {
        return Ok(false);
    }
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// 打开 / 关闭自启；返回改动后的**真实**状态（以系统为准，不盲信传入值）。
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if !autostart_available() {
        return Err("便携版不支持开机自启，请使用安装版".into());
    }
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    manager.is_enabled().map_err(|e| e.to_string())
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledTools {
    yt_dlp_path: String,
    ffmpeg_path: Option<String>,
    yt_dlp_available: bool,
    ffmpeg_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolProgress {
    tool: String,
    phase: String,
    downloaded: u64,
    total: u64,
}

#[cfg(windows)]
fn emit_tool_progress(app: &AppHandle, tool: &str, phase: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        "tools:progress",
        ToolProgress {
            tool: tool.to_string(),
            phase: phase.to_string(),
            downloaded,
            total,
        },
    );
}

#[cfg(windows)]
fn install_client(proxy: Option<&str>, use_system_proxy: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("FluxDL/0.1.0")
        .connect_timeout(std::time::Duration::from_secs(20));
    if let Some(proxy) = proxy.filter(|p| !p.trim().is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy.trim()).map_err(|e| e.to_string())?);
    } else if !use_system_proxy {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|e| e.to_string())
}

#[cfg(windows)]
async fn download_tool(
    app: &AppHandle,
    client: &reqwest::Client,
    tool: &str,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("连接 {tool} 下载源失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "下载 {tool} 失败：HTTP {}",
            resp.status().as_u16()
        ));
    }
    let total = resp.content_length().unwrap_or(0);
    let tmp = dest.with_file_name(format!(
        "{}.part",
        dest.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download")
    ));
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("创建临时文件失败：{e}"))?;
    let mut downloaded = 0u64;
    let mut last_emit = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载 {tool} 中断：{e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入 {tool} 失败：{e}"))?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed().as_millis() >= 150 {
            last_emit = std::time::Instant::now();
            emit_tool_progress(app, tool, "download", downloaded, total);
        }
    }
    drop(file);
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| format!("保存 {tool} 失败：{e}"))?;
    emit_tool_progress(app, tool, "done", downloaded, total.max(downloaded));
    Ok(())
}

#[cfg(windows)]
async fn extract_ffmpeg(zip_path: PathBuf, dir: PathBuf) -> Result<PathBuf, String> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&zip_path)
            .map_err(|e| format!("打开 ffmpeg 压缩包失败：{e}"))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("解析压缩包失败：{e}"))?;
        let mut ffmpeg = None;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let base = entry.name().rsplit('/').next().unwrap_or("").to_string();
            if base != "ffmpeg.exe" && base != "ffprobe.exe" {
                continue;
            }
            let out_path = dir.join(&base);
            let mut out = std::fs::File::create(&out_path)
                .map_err(|e| format!("写入 {base} 失败：{e}"))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("解压 {base} 失败：{e}"))?;
            if base == "ffmpeg.exe" {
                ffmpeg = Some(out_path);
            }
        }
        ffmpeg.ok_or_else(|| "压缩包里没有 ffmpeg.exe".to_string())
    })
    .await
    .map_err(|e| format!("解压任务失败：{e}"))?
}

#[tauri::command]
async fn install_tools(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledTools, String> {
    // 内置优先：随包 tools/ 里同时有 yt-dlp 与 ffmpeg 时直接采用，不再联网下载。
    // setup() 里已经自动做过一次，这里让设置页的「检测/安装」按钮也能得到确定结果。
    let (bundled_yt, bundled_ff) = bundled_tool_paths(&app);
    if let (Some(yt), Some(ff)) = (bundled_yt, bundled_ff) {
        let yt_path = yt.to_string_lossy().to_string();
        let ff_path = ff.to_string_lossy().to_string();
        let yt_ok = probe_binary(&yt_path, &["--version"]).await;
        let ff_ok = probe_binary(&ff_path, &["-version"]).await;
        if yt_ok && ff_ok {
            let mut options = state.engine.options();
            options.yt_dlp_path = yt_path;
            options.ffmpeg_path = Some(ff_path);
            // 随包 aria2c 一并接管；缺失时保持 None，引擎自动退回原生下载器。
            if let Some(aria2) = bundled_aria2_path(&app) {
                if aria2_version(&aria2).is_some() {
                    options.aria2_path = Some(aria2.to_string_lossy().to_string());
                }
            }
            state.engine.set_options(options.clone()).await;
            return Ok(InstalledTools {
                yt_dlp_path: options.yt_dlp_path,
                ffmpeg_path: options.ffmpeg_path,
                yt_dlp_available: true,
                ffmpeg_available: true,
            });
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (app, state);
        Err("未找到内置工具，且当前平台不提供自动下载".into())
    }

    #[cfg(windows)]
    {
        const YT_DLP_URL: &str =
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
        const FFMPEG_URL: &str =
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("无法定位应用数据目录：{e}"))?
            .join("bin");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("创建工具目录失败：{e}"))?;

        let install_opts = state.engine.options();
        let client = install_client(
            install_opts.proxy.as_deref(),
            install_opts.use_system_proxy,
        )?;

        let yt_dlp = dir.join("yt-dlp.exe");
        download_tool(&app, &client, "yt-dlp", YT_DLP_URL, &yt_dlp).await?;

        let zip_path = dir.join("ffmpeg-temp.zip");
        download_tool(&app, &client, "ffmpeg", FFMPEG_URL, &zip_path).await?;
        emit_tool_progress(&app, "ffmpeg", "extract", 0, 0);
        let ffmpeg = extract_ffmpeg(zip_path.clone(), dir.clone()).await?;
        tokio::fs::remove_file(&zip_path).await.ok();

        let mut options = state.engine.options();
        options.yt_dlp_path = yt_dlp.to_string_lossy().to_string();
        options.ffmpeg_path = Some(ffmpeg.to_string_lossy().to_string());
        state.engine.set_options(options.clone()).await;

        let yt_dlp_available = probe_binary(&options.yt_dlp_path, &["--version"]).await;
        let ffmpeg_available =
            probe_binary(options.ffmpeg_path.as_deref().unwrap_or(""), &["-version"]).await;

        Ok(InstalledTools {
            yt_dlp_path: options.yt_dlp_path,
            ffmpeg_path: options.ffmpeg_path,
            yt_dlp_available,
            ffmpeg_available,
        })
    }
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

/// 随包内置的 yt-dlp / ffmpeg 放在 exe 旁的 `tools/` 目录。
/// 兼容三种布局：安装版的 resource_dir、便携版的 current_exe、开发态的源码目录。
fn bundled_tools_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("tools"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("tools"));
            // 版本库启动：主程序在 `app-versions/<版本>/fluxdl.exe`，而 tools 在
            // 上两层的应用根（`<应用根>/tools`）。只查 exe 同级会漏掉，导致 aria2c
            // 探测失败、静默回退单连接下载 —— 表现为「一直几百 K、加速不生效」。
            let mut up = parent.to_path_buf();
            for _ in 0..3 {
                match up.parent() {
                    Some(p) => {
                        up = p.to_path_buf();
                        candidates.push(up.join("tools"));
                    }
                    None => break,
                }
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools"));
    }
    candidates.into_iter().find(|p| p.is_dir())
}

/// 返回 (yt-dlp, ffmpeg) 两个可执行文件；缺失的那一个为 None。
fn bundled_tool_paths(app: &AppHandle) -> (Option<PathBuf>, Option<PathBuf>) {
    let Some(dir) = bundled_tools_dir(app) else {
        return (None, None);
    };
    let (yt_name, ff_name) = if cfg!(windows) {
        ("yt-dlp.exe", "ffmpeg.exe")
    } else {
        ("yt-dlp", "ffmpeg")
    };
    let pick = |name: &str| {
        let p = dir.join(name);
        if p.is_file() { Some(p) } else { None }
    };
    (pick(yt_name), pick(ff_name))
}

/// 用户在设置里手动指定的、真实存在的路径优先；否则一律用随包工具。
fn apply_bundled_tools(
    options: &mut EngineOptions,
    bundled: &(Option<PathBuf>, Option<PathBuf>),
    aria2: Option<&PathBuf>,
) -> bool {
    let mut changed = false;
    if let Some(path) = bundled.0.as_ref() {
        let current = options.yt_dlp_path.trim();
        let custom_valid = !current.is_empty()
            && current != "yt-dlp"
            && current != "yt-dlp.exe"
            && Path::new(current).is_file();
        if !custom_valid {
            options.yt_dlp_path = path.to_string_lossy().to_string();
            changed = true;
        }
    }
    if let Some(path) = bundled.1.as_ref() {
        let current = options.ffmpeg_path.as_deref().unwrap_or("").trim();
        let custom_valid = !current.is_empty() && Path::new(current).is_file();
        if !custom_valid {
            options.ffmpeg_path = Some(path.to_string_lossy().to_string());
            changed = true;
        }
    }
    // aria2c：随包就写绝对路径。用户手动配置过且文件存在时不覆盖。
    if let Some(path) = aria2 {
        let current = options.aria2_path.as_deref().unwrap_or("").trim();
        let custom_valid = !current.is_empty() && Path::new(current).is_file();
        if !custom_valid {
            options.aria2_path = Some(path.to_string_lossy().to_string());
            changed = true;
        }
    }
    changed
}

/// 随包 aria2c 的绝对路径；找不到返回 None（引擎侧会自动退回 yt-dlp 原生下载器）。
///
/// **不复用 `bundled_tool_paths`**：那个函数若一个工具都没找到会直接返回
/// `(None, None)`，拿它判 aria2 会在「aria2 有、yt-dlp 没」时误判成缺失。
/// 这里独立探测，且必须返回**文件**路径而不是目录（yt-dlp 的
/// `--external-downloader` 要的是可执行文件本身）。
fn bundled_aria2_path(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) { "aria2c.exe" } else { "aria2c" };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("tools").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("tools").join(name));
            // 便携版：直接躺在主程序旁边
            candidates.push(parent.join(name));
            // 版本库启动：`app-versions/<版本>/fluxdl.exe` 时 tools 在上两层。
            let mut up = parent.to_path_buf();
            for _ in 0..3 {
                match up.parent() {
                    Some(p) => {
                        up = p.to_path_buf();
                        candidates.push(up.join("tools").join(name));
                        candidates.push(up.join(name));
                    }
                    None => break,
                }
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools").join(name));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// aria2c 的版本号（写进设置页展示用）。探测失败返回 None，不影响功能。
fn aria2_version(path: &Path) -> Option<String> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    // 首行形如 `aria2 version 1.37.0`
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?.trim();
    first.split_whitespace().nth(2).map(|s| s.to_string())
}

#[tauri::command]
fn open_extension_folder(app: AppHandle) -> Result<(), String> {
    let dir = extension_dir(&app);
    if !dir.exists() {
        return Err("未找到浏览器扩展目录，请重新安装 FluxDL".into());
    }
    opener::open(&dir).map_err(|e| e.to_string())
}

const CAPTURE_TOKEN: &str = "fluxdl-local-v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRequest {
    url: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    referer: Option<String>,
    #[serde(default, alias = "user_agent")]
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

async fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
    allow_origin: Option<&str>,
) {
    let payload = capture_guard::build_response(status, reason, body, allow_origin);
    let _ = stream.write_all(payload.as_bytes()).await;
    let _ = stream.flush().await;
}

/// 是否需要交给 yt-dlp 处理（媒体任务）。
///
/// **唯一权威名单**：前端 `src/lib/format.ts` 的 `isMediaUrl` 必须与这里逐项一致。
/// 0.3.3 曾出现两份名单互相矛盾（前端只有国外站点、这里只有国内站点），
/// 导致同一链接从浏览器扩展进来建成 HTTP 直链、从桌面新建又建成媒体任务。
///
/// 按「主机名」精确 / 后缀匹配，不能用 `contains`：`https://example.com/bilibili.com-x`
/// 这类把域名写进路径的链接会被误判；`x.com` 用 includes 还会命中 `apex.com`。
fn looks_like_media(url: &str) -> bool {
    // 0.3.5：CDN 容器直链（如 v2.kuaishou.com/abc.mp4）虽带站点后缀，却是可直接
    // 多连接下载的整文件，交给 yt-dlp 只会报 Unsupported URL。用引擎侧的权威
    // 规则短路成 HTTP 直链任务，保证扩展自动接管 / 资源列表点选都走对路径。
    if fluxdl_engine::is_direct_media_file(url) {
        return false;
    }
    // HLS / DASH 清单直链（.m3u8 / .mpd）不是整文件，无论域名都交给 yt-dlp
    // 解析并合并分片，与前端 isHlsManifest 保持一致。
    if fluxdl_engine::is_hls_manifest(url) {
        return true;
    }
    let host = host_of(url);
    const HOSTS: &[&str] = &[
        // 国内
        "bilibili.com",
        "b23.tv",
        "douyin.com",
        "iesdouyin.com",
        "kuaishou.com",
        "xiaohongshu.com",
        "xhslink.com",
        "weibo.com",
        "iqiyi.com",
        "youku.com",
        "mgtv.com",
        "v.qq.com",
        "music.163.com",
        "zhihu.com",
        "ixigua.com",
        "acfun.cn",
        // 国外（与前端名单同步，扩展自动接管媒体页面时不会误建成 HTTP 直链）
        "youtube.com",
        "youtu.be",
        "vimeo.com",
        "tiktok.com",
        "twitter.com",
        "x.com",
        "instagram.com",
        "facebook.com",
        "twitch.tv",
        "dailymotion.com",
        "nicovideo.jp",
    ];
    HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// 抽出小写主机名（去端口、去 userinfo）。不是合法 URL 时返回空串。
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let rest = rest.split(['/', '?', '#']).next().unwrap_or("");
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
    rest.split(':').next().unwrap_or("").to_ascii_lowercase()
}

/// 扩展捕获请求 → 任务类型：显式 `kind` 优先，未指定时才按站点名单兜底。
///
/// 0.3.9：扩展「本页资源」嗅探到的都是文件 / 视频直链，下载时一律显式带
/// `kind:"http"`。这些直链常无容器扩展名（抖快 CDN 的 `.../play/?mime_type=
/// video_mp4`），`is_direct_media_file` 认不出，若走名单兜底会被判成 Media 任务、
/// 再被 `media_page_blocker` 拒绝 —— 表现就是「本页资源点了下载没反应」。
/// 抽成纯函数便于用单测锁死「显式 http 压过名单」这条契约。
fn capture_task_kind(kind: Option<&str>, url: &str) -> TaskKind {
    match kind {
        Some("media") => TaskKind::Media,
        Some("http") => TaskKind::Http,
        _ if looks_like_media(url) => TaskKind::Media,
        _ => TaskKind::Http,
    }
}

async fn handle_capture_conn(mut stream: TcpStream, engine: Arc<Engine>) {
    let Some(request) = read_http_request(&mut stream).await else {
        return;
    };

    // P0-3 修复：任何请求（含 OPTIONS 预检和 /api/health）都必须先过准入检查。
    // 令牌是写在扩展源码里的公开值，挡不住网页；靠 Host + Origin 才能把
    // 「任意网页静默添加下载任务」这条路封死。
    if let Err(reason) = capture_guard::check(&request.headers) {
        let body = serde_json::json!({ "ok": false, "error": reason }).to_string();
        write_http_response(&mut stream, 403, "Forbidden", &body, None).await;
        return;
    }
    // 只回显扩展自身的 Origin，不返回 `*`，否则等于给网页发通行证。
    let allow_origin = capture_guard::extension_origin(&request.headers);

    if request.method == "OPTIONS" {
        write_http_response(&mut stream, 204, "No Content", "", allow_origin).await;
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
        write_http_response(&mut stream, 200, "OK", &body.to_string(), allow_origin).await;
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
            allow_origin,
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
            allow_origin,
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
            write_http_response(&mut stream, 400, "Bad Request", &body.to_string(), allow_origin).await;
            return;
        }
    };

    let url = payload.url.trim().to_string();
    if url.is_empty() {
        let body = serde_json::json!({ "ok": false, "error": "链接不能为空" });
        write_http_response(&mut stream, 400, "Bad Request", &body.to_string(), allow_origin).await;
        return;
    }

    // 捕获接口幂等去重：列表里已有同 URL 的未完成任务，或 15 秒内刚由同 URL 建过任务，
    // 直接返回已有任务 ID，防止扩展重启/并发事件导致重复下单。
    let now_ms = chrono::Utc::now().timestamp_millis();
    if let Some(existing) = engine.tasks().await.into_iter().find(|t| {
        t.url == url
            && (t.status.is_active()
                || t.status == fluxdl_engine::TaskStatus::Paused
                || t.pending_approval
                || now_ms.saturating_sub(t.created_at) < 15_000)
    }) {
        let body = serde_json::json!({
            "ok": true,
            "id": existing.id,
            "duplicate": true,
            "task": existing,
        });
        write_http_response(&mut stream, 200, "OK", &body.to_string(), allow_origin).await;
        return;
    }

    let kind = capture_task_kind(payload.kind.as_deref(), &url);
    let require_approval = engine.options().approve_captured_downloads;

    let options = NewTaskOptions {
        filename: payload.filename,
        prefer_header_filename: true,
        referer: payload.referer,
        user_agent: payload.user_agent,
        // 是否需手动点「允许」由设置项 approve_captured_downloads 控制（默认关闭）。
        require_approval,
        ..Default::default()
    };

    match engine.add(kind, &url, options).await {
        Ok(task) => {
            let task_id = task.id.clone();
            let body = serde_json::json!({ "ok": true, "id": task_id, "task": task });
            write_http_response(&mut stream, 200, "OK", &body.to_string(), allow_origin).await;
        }
        Err(err) => {
            let body = serde_json::json!({ "ok": false, "error": err.to_string() });
            write_http_response(&mut stream, 400, "Bad Request", &body.to_string(), allow_origin).await;
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
        // macOS 用 LaunchAgent（比 AppleScript 稳定）；args 传 None，
        // 自启时就是一次普通的冷启动，不需要额外命令行参数。
        // 只在 setup 里构造 AutoLaunchManager，不主动 enable —— 默认关闭。
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // 桌面通知：下载完成/失败时提醒（应用在托盘或后台时尤其有用）。
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 启动自检：这次跑的是不是"刚换上来、还没验证过"的版本？
            // 是就记一次尝试；连续失败达阈值会自动回退到上一版本，
            // 回退脚本等本进程退出后才动文件，所以这里可以直接 exit。
            let boot_notice = appversion::boot_guard(app.handle());

            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let _ = std::fs::create_dir_all(&data_dir);

            // 内置 yt-dlp / ffmpeg：先复制到用户数据目录（可写），版本管理才有地方落盘；
            // 复制失败时退回随包路径，保证功能不因此中断。
            let bundled = tools::ensure_managed_tools(app.handle());
            // 上次若在替换中途退出，这里判定并自动回滚。
            let startup_notice = boot_notice.or_else(|| version::recover_on_startup(app.handle()));
            if let Some(msg) = startup_notice.as_deref() {
                eprintln!("[fluxdl] {msg}");
            }
            version::set_startup_notice(startup_notice);

            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            // Engine::new spawns its 500 ms progress ticker, so it must run
            // inside the Tokio runtime context. 单独 clone 一份给 async move，
            // data_dir 后面还要传给本地捕获服务用于落地 cookie 临时文件。
            let engine_dir = data_dir.clone();
            // aria2 路径解析需要 AppHandle；在进 async move 之前算好，避免跨 await 持有引用。
            let aria2 = bundled_aria2_path(app.handle());
            let engine = tauri::async_runtime::block_on(async move {
                let engine = Engine::new(engine_dir.join("tasks.json"), tx);
                let mut options = engine.options();
                if apply_bundled_tools(&mut options, &bundled, aria2.as_ref()) {
                    engine.set_options(options).await;
                } else if engine.recovered_tasks() {
                    engine.save().await;
                }
                engine
            });
            let clipboard_enabled = Arc::new(AtomicBool::new(
                engine.options().clipboard_watch,
            ));

            let capture_engine = engine.clone();
            app.manage(AppState {
                engine,
                clipboard_enabled: clipboard_enabled.clone(),
            });
            start_capture_server(capture_engine.clone());

            // 后台静默更新随包内置的 yt-dlp（24h 冷却、失败静默），让新装用户
            // 尽早用上能跟上 YouTube 的版本，无需等待下一次 FluxDL 整包发布。
            let updater = capture_engine.clone();
            tauri::async_runtime::spawn(async move {
                let _ = updater.update_ytdlp(false).await;
            });

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

            // 走到这里说明窗口、引擎、捕获服务都起来了，才算"这次启动成功"：
            // 把 pending 确认为 active，并清零失败计数。启动阶段就崩的进程
            // 永远走不到这一行，计数会留在磁盘上，供下次启动判定回退。
            appversion::mark_healthy(app.handle());
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
            update_task_url,
            verify_task_checksum,
            approve_task,
            approve_all_tasks,
            remove_task,
            pause_all,
            resume_all,
            set_task_speed_limit,
            get_engine_options,
            set_engine_options,
            set_clipboard_watch,
            autostart_available,
            autostart_enabled,
            set_autostart,
            engine_info,
            install_tools,
            version::app_version_info,
            version::check_app_update,
            version::app_update_history,
            version::download_app_update,
            version::apply_app_update_and_restart,
            version::take_startup_notice,
            appversion::app_version_list,
            appversion::activate_app_version,
            appversion::delete_app_version,
            tools::tool_version_list,
            tools::tool_install_version,
            tools::tool_activate_version,
            tools::tool_rollback,
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

/// 跨边界字段契约的回归测试。
///
/// 这些用例只依赖 serde / 纯函数，不启动 Tauri runtime，因此 Linux CI 也能跑。
/// 0.3.3 的实际缺陷都出在「扩展手写 JSON → Rust serde 结构」这条边界上：
/// 字段名写错不报错、只被静默忽略，用户看到的是任务失败且无提示。
#[cfg(test)]
mod contract_tests {
    use super::*;

    /// P1-2：扩展的 User-Agent 必须能被服务端读到。
    /// `CaptureRequest` 走 `rename_all = "camelCase"`，期望 key 是 `userAgent`；
    /// 0.3.3 扩展发的是 `user_agent` → `None`。0.3.4 扩展改发 camelCase，
    /// 同时这里保留 snake_case alias 兼容旧版扩展。
    #[test]
    fn capture_request_accepts_both_user_agent_spellings() {
        let camel: CaptureRequest = serde_json::from_str(
            r#"{"url":"https://example.com/a.mp4","userAgent":"UA-camel","referer":"https://example.com/"}"#,
        )
        .unwrap();
        assert_eq!(camel.user_agent.as_deref(), Some("UA-camel"));
        assert_eq!(camel.referer.as_deref(), Some("https://example.com/"));
        assert!(camel.kind.is_none(), "扩展不传 kind 时应走 Rust 站点名单");

        let snake: CaptureRequest = serde_json::from_str(
            r#"{"url":"https://example.com/a.mp4","user_agent":"UA-snake"}"#,
        )
        .unwrap();
        assert_eq!(
            snake.user_agent.as_deref(),
            Some("UA-snake"),
            "旧版扩展的 snake_case 字段必须靠 alias 兼容，不能静默丢失"
        );

        let bare: CaptureRequest =
            serde_json::from_str(r#"{"url":"https://example.com/a.mp4"}"#).unwrap();
        assert!(bare.user_agent.is_none());
        assert!(bare.filename.is_none());
    }

    /// 0.3.9「本页资源做好了」：无容器扩展名的抖快视频直链，若扩展不显式带
    /// kind，会被 looks_like_media 判成 Media 再被 media_page_blocker 拒绝；
    /// 扩展显式带 kind:"http" 后必须压过名单兜底，稳定建成 Http 任务。
    #[test]
    fn explicit_http_kind_overrides_media_host_heuristic() {
        let no_ext_douyin = "https://www.douyin.com/aweme/v1/play/?mime_type=video_mp4&token=abc";
        let no_ext_kuaishou = "https://v2.kuaishou.com/rest/wd/play/?mime_type=video_mp4";

        // 前提：这两个 URL 无容器扩展名，走名单兜底确实会被判成 Media（复现 bug）。
        assert!(looks_like_media(no_ext_douyin), "无扩展名抖音直链会命中站点名单");
        assert!(looks_like_media(no_ext_kuaishou), "无扩展名快手直链会命中站点名单");

        // 不带 kind：名单兜底 → Media（这是修复前「本页资源点了没反应」的成因）。
        assert_eq!(capture_task_kind(None, no_ext_douyin), TaskKind::Media);
        assert_eq!(capture_task_kind(None, no_ext_kuaishou), TaskKind::Media);

        // 显式 kind:"http"：压过名单 → Http，绕过 media_page_blocker。
        assert_eq!(
            capture_task_kind(Some("http"), no_ext_douyin),
            TaskKind::Http,
            "本页资源直链显式 http 必须是 Http 任务",
        );
        assert_eq!(
            capture_task_kind(Some("http"), no_ext_kuaishou),
            TaskKind::Http,
            "本页资源直链显式 http 必须是 Http 任务",
        );

        // 可整页解析的页面仍按 media 建任务；带扩展名的直链不带 kind 也短路成 Http。
        assert_eq!(
            capture_task_kind(Some("media"), "https://www.bilibili.com/video/BV1xx"),
            TaskKind::Media,
        );
        assert_eq!(
            capture_task_kind(None, "https://v2.kuaishou.com/a.mp4"),
            TaskKind::Http,
            "带 .mp4 扩展名的 CDN 直链仍短路成 Http",
        );
    }

    /// P0-1：桌面新建（前端 isMediaUrl）与扩展自动接管（这里 looks_like_media）
    /// 必须是同一份站点名单，且按主机名精确 / 后缀匹配。
    /// 0.3.3 两份名单互相矛盾，YouTube / 爱奇艺等链接从两条入口会建成不同任务类型。
    #[test]
    fn media_hosts_cover_both_entry_points_without_false_positives() {
        for url in [
            "https://www.bilibili.com/video/BV1xx",
            "https://b23.tv/abc",
            "https://v.douyin.com/abc",
            "https://www.kuaishou.com/x",
            "https://weibo.com/tv/show/x",
            "https://www.xiaohongshu.com/explore/x",
            "https://www.iqiyi.com/v_x.html",
            "https://v.youku.com/v_show/id_X.html",
            "https://www.mgtv.com/b/1/2",
            "https://v.qq.com/x/cover/x.html",
            "https://www.acfun.cn/v/ac1",
            "https://www.ixigua.com/1",
            "https://www.youtube.com/watch?v=x",
            "https://youtu.be/abc",
            "https://vimeo.com/123",
            "https://www.tiktok.com/@a/video/1",
            "https://x.com/a/status/1",
            "https://www.instagram.com/p/x",
            "https://www.twitch.tv/videos/1",
            "https://www.nicovideo.jp/watch/sm1",
        ] {
            assert!(looks_like_media(url), "媒体站点应被识别：{url}");
        }
        // includes 会把路径、查询、相似域名都误判成媒体站点
        for url in [
            "https://example.com/bilibili.com-x/video.mp4",
            "https://apex.com/x.com-logo.png",
            "https://linux.com/download/youtube.com-player.zip",
            "https://cdn.example.org/a.zip?ref=x.com",
            "https://notbilibili.com/video/1",
            "https://user:pw@b23.tv:443/abc", // userinfo / 端口应被正确剥离
        ] {
            if url.contains("b23.tv") {
                assert!(looks_like_media(url), "合法 b23.tv 带 userinfo 应仍识别：{url}");
            } else {
                assert!(!looks_like_media(url), "路径/查询/相似域名不得误判：{url}");
            }
        }
    }

    /// 0.3.5：扩展资源列表 / 自动接管里点选的 CDN 容器直链（如
    /// `v2.kuaishou.com/abc.mp4`）虽带站点后缀，也必须短路成 HTTP 直链任务，
    /// 否则会被建成 Media 交给 yt-dlp 报 Unsupported URL。分片清单不短路。
    /// 站点网页链接仍按名单判媒体 —— B 档后抖音详情页 / 短链交给 yt-dlp 的
    /// Douyin 提取器解析（可在设置里配置浏览器 Cookie），快手与聚合首页仍由
    /// media_page_blocker / failure_hint 给出诚实指引。
    #[test]
    fn direct_container_files_bypass_media_detection() {
        for url in [
            "https://v2.kuaishou.com/abc.mp4",
            "https://cdn.douyin.com/2024/x.mp4?token=deadbeef",
            "https://cdn.example.com/a.MKV",
            "https://cdn.example.com/song.mp3#t=1",
        ] {
            assert!(
                fluxdl_engine::is_direct_media_file(url),
                "容器直链应被识别：{url}"
            );
            assert!(
                !looks_like_media(url),
                "容器直链不得建成媒体任务：{url}"
            );
        }
        for url in [
            "https://cdn.example.com/seg-1.m4s",
            "https://cdn.example.com/index.m3u8?token=x",
            "https://cdn.example.com/manifest.mpd",
            "https://www.bilibili.com/video/BV1xx",
        ] {
            assert!(
                !fluxdl_engine::is_direct_media_file(url),
                "分片 / 页面不应被当成容器直链：{url}"
            );
        }
        assert!(looks_like_media("https://www.kuaishou.com/new-reco"));
        assert!(looks_like_media(
            "https://www.douyin.com/jingxuan?modal_id=7702008165390421263"
        ));
    }
}

/// 自启可用性判据的回归测试：只有 exe 同级存在 uninstall.exe 才算安装版。
/// 便携版解压目录、单独一个 exe、以及 tools/ 目录都不能当成安装版标记。
#[cfg(test)]
mod autostart_tests {
    use super::has_install_marker;

    #[test]
    fn only_install_dir_with_uninstall_exe_is_eligible() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("fluxdl.exe");
        std::fs::write(&exe, b"exe").unwrap();

        // 只有主程序：单 exe / 便携目录，不给自启开关
        assert!(!has_install_marker(&exe));

        // 便携版常见的 tools/ 与 browser-extension/ 不能算安装标记
        std::fs::create_dir(dir.path().join("tools")).unwrap();
        std::fs::create_dir(dir.path().join("browser-extension")).unwrap();
        std::fs::write(dir.path().join("portable.flag"), b"").unwrap();
        assert!(!has_install_marker(&exe), "便携版不应被当成安装版");

        // NSIS 安装版一定带 uninstall.exe
        std::fs::write(dir.path().join("uninstall.exe"), b"uninst").unwrap();
        assert!(has_install_marker(&exe), "安装版应识别为可自启");

        // 标记必须在 exe 同级，放到子目录不算
        let nested = dir.path().join("sub");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("fluxdl.exe"), b"exe").unwrap();
        assert!(!has_install_marker(&nested.join("fluxdl.exe")));
    }
}
