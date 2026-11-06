//! yt-dlp / ffmpeg 的版本管理：装多个版本、随时切换、一键回滚。
//!
//! 为什么要复制到用户数据目录而不是就地更新：
//! - 安装目录（`%LOCALAPPDATA%\FluxDL` 或便携版解压目录）是「干净副本」，
//!   往里写可更新内容会让覆盖安装 / 删文件夹即卸载的语义变模糊；
//! - 多版本共存需要同时留两份工具，安装目录不该承担这个角色；
//! - 数据目录在覆盖安装时不会被动，版本历史得以保留。
//! 所以首次启动把随包工具复制一份到 `%LOCALAPPDATA%\<identifier>\tools`，
//! 之后所有更新都落在那里，随包文件只做初始来源。
//!
//! 目录布局（`<localAppData>/tools`）：
//! ```text
//! yt-dlp-2025.11.01.exe          单文件
//! ffmpeg-9.0/ffmpeg.exe (+dll)   目录，含 shared 版依赖
//! tool-state.json                当前激活 / 上一个版本 / 已装列表
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use fluxdl_engine::update::{self, ToolState};

use crate::AppState;

pub const TOOL_YTDLP: &str = "yt-dlp";
pub const TOOL_FFMPEG: &str = "ffmpeg";

const USER_AGENT: &str = "FluxDL/0.1 (tool-manager)";
/// 远端版本列表的进程内缓存：GitHub 未登录限流 60 次/小时，
/// 频繁切换设置页会很容易打满，所以 10 分钟内复用结果。
const REMOTE_TTL_MS: i64 = 10 * 60 * 1000;

const YTDLP_RELEASES: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases?per_page=12";
const FFMPEG_RELEASES: &str =
    "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest";

fn tools_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("tools")
}

fn state_file(app: &AppHandle) -> PathBuf {
    tools_root(app).join("tool-state.json")
}

/// 某个版本在磁盘上的位置。yt-dlp 是单文件，ffmpeg 是目录（需要 dll）。
fn version_path(root: &Path, tool: &str, version: &str) -> PathBuf {
    if tool == TOOL_FFMPEG {
        root.join(format!("ffmpeg-{version}")).join("ffmpeg.exe")
    } else {
        root.join(format!("yt-dlp-{version}.exe"))
    }
}

fn exe_name(tool: &str) -> &'static str {
    if tool == TOOL_FFMPEG {
        if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        }
    } else if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

/// 跑一下工具的版本命令，确认它真的能执行。
fn probe_version(path: &Path, tool: &str) -> Option<String> {
    let arg = if tool == TOOL_FFMPEG { "-version" } else { "--version" };
    let mut cmd = std::process::Command::new(path);
    cmd.arg(arg)
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
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?.trim().to_string();
    if first.is_empty() {
        return None;
    }
    if tool == TOOL_FFMPEG {
        // `ffmpeg version 9.0-full_build-...` → 9.0
        let after = first.split("version ").nth(1)?.split_whitespace().next()?;
        Some(after.split('-').next().unwrap_or(after).to_string())
    } else {
        Some(first)
    }
}

/// 首次启动把随包工具复制到可写目录，并登记版本。返回可用的两个路径。
/// 复制失败（磁盘满、权限）时退回随包路径，保证还能用。
pub fn ensure_managed_tools(app: &AppHandle) -> (Option<PathBuf>, Option<PathBuf>) {
    let root = tools_root(app);
    if std::fs::create_dir_all(&root).is_err() {
        return crate::bundled_tool_paths(app);
    }
    let (bundled_yt, bundled_ff) = crate::bundled_tool_paths(app);
    let mut state = ToolState::load(&state_file(app));
    let mut changed = false;

    let yt = adopt(&root, TOOL_YTDLP, bundled_yt.as_deref(), &mut state, &mut changed);
    let ff = adopt(&root, TOOL_FFMPEG, bundled_ff.as_deref(), &mut state, &mut changed);

    if changed {
        let _ = state.save(&state_file(app));
    }
    (yt.or(bundled_yt), ff.or(bundled_ff))
}

fn adopt(
    root: &Path,
    tool: &str,
    bundled: Option<&Path>,
    state: &mut ToolState,
    changed: &mut bool,
) -> Option<PathBuf> {
    let slot = state.slot(tool);
    // 已经有激活版本且文件还在：直接用，不重复复制。
    if let Some(active) = slot.active.as_deref() {
        let path = version_path(root, tool, active);
        if path.is_file() {
            return Some(path);
        }
    }
    let src = bundled?;
    let version = probe_version(&src, tool).unwrap_or_else(|| "bundled".to_string());
    let dest = version_path(root, tool, &version);

    if !dest.is_file() {
        if tool == TOOL_FFMPEG {
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        if std::fs::copy(&src, &dest).is_err() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
        }
        *changed = true;
    }
    // 复制出来的文件跑不起来就别登记，避免把用户指到坏文件上。
    if probe_version(&dest, tool).is_none() {
        return None;
    }
    if slot.active.as_deref() != Some(version.as_str()) {
        state.activate(tool, &version);
        *changed = true;
    }
    Some(dest)
}

// ---------------------------------------------------------------------------
// 远端版本列表
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVersion {
    pub version: String,
    pub url: String,
    pub size: Option<u64>,
    pub released_at: Option<String>,
    pub notes: Option<String>,
}

static REMOTE_CACHE: OnceLock<Mutex<HashMap<String, (i64, Vec<RemoteVersion>)>>> = OnceLock::new();

fn remote_cache() -> &'static Mutex<HashMap<String, (i64, Vec<RemoteVersion>)>> {
    REMOTE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn fetch_remote(tool: &str, proxy: Option<&str>) -> Vec<RemoteVersion> {
    {
        let cache = remote_cache().lock().unwrap();
        if let Some((at, list)) = cache.get(tool) {
            if update::now_ms() - at < REMOTE_TTL_MS {
                return list.clone();
            }
        }
    }

    let url = match tool {
        TOOL_YTDLP => YTDLP_RELEASES,
        TOOL_FFMPEG if cfg!(windows) => FFMPEG_RELEASES,
        _ => return Vec::new(),
    };

    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(25));
    if let Some(proxy) = proxy.filter(|p| !p.trim().is_empty()) {
        if let Ok(p) = reqwest::Proxy::all(proxy.trim()) {
            builder = builder.proxy(p);
        }
    }
    let Ok(client) = builder.build() else {
        return Vec::new();
    };

    let mut list = Vec::new();
    // 直连失败走镜像：国内访问 api.github.com 经常 TLS 超时。
    for target in [url.to_string(), format!("https://ghfast.top/{url}")] {
        let Ok(resp) = client.get(&target).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(text) = resp.text().await else {
            continue;
        };
        list = parse_remote(tool, &text);
        if !list.is_empty() {
            break;
        }
    }

    let mut cache = remote_cache().lock().unwrap();
    cache.insert(tool.to_string(), (update::now_ms(), list.clone()));
    list
}

/// 解析 GitHub API 响应。yt-dlp 用 releases 数组，ffmpeg 用单个 release 对象。
fn parse_remote(tool: &str, json: &str) -> Vec<RemoteVersion> {
    if tool == TOOL_FFMPEG {
        return update::parse_ffmpeg_versions(json)
            .into_iter()
            .map(|(version, url, size)| RemoteVersion {
                version,
                url,
                size,
                released_at: None,
                notes: Some("BtbN FFmpeg-Builds · lgpl-shared".into()),
            })
            .collect();
    }

    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(releases) = value.as_array() else {
        return Vec::new();
    };
    let asset_name = exe_name(TOOL_YTDLP);
    let mut out = Vec::new();
    for release in releases {
        let version = release
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_start_matches('v')
            .to_string();
        if version.is_empty() {
            continue;
        }
        if let Some(true) = release.get("draft").and_then(|v| v.as_bool()) {
            continue;
        }
        if let Some(true) = release.get("prerelease").and_then(|v| v.as_bool()) {
            continue;
        }
        let Some(assets) = release.get("assets").and_then(|v| v.as_array()) else {
            continue;
        };
        let hit = assets
            .iter()
            .find(|a| a.get("name").and_then(|v| v.as_str()) == Some(asset_name));
        let Some(hit) = hit else { continue };
        let Some(url) = hit.get("browser_download_url").and_then(|v| v.as_str()) else {
            continue;
        };
        out.push(RemoteVersion {
            version,
            url: url.to_string(),
            size: hit.get("size").and_then(|v| v.as_u64()),
            released_at: release
                .get("published_at")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            notes: release
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(120).collect()),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolVersionItem {
    pub version: String,
    pub path: Option<String>,
    pub size: Option<u64>,
    pub installed: bool,
    pub active: bool,
    pub released_at: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolVersionList {
    pub tool: String,
    pub active: Option<String>,
    pub previous: Option<String>,
    pub latest: Option<String>,
    pub update_available: bool,
    pub installed: Vec<ToolVersionItem>,
    pub available: Vec<ToolVersionItem>,
    /// 远端不可达时的提示，界面据此显示「仅显示本地版本」。
    pub warning: Option<String>,
}

#[tauri::command]
pub async fn tool_version_list(
    app: AppHandle,
    state: State<'_, AppState>,
    tool: String,
) -> Result<ToolVersionList, String> {
    if tool != TOOL_YTDLP && tool != TOOL_FFMPEG {
        return Err(format!("未知工具：{tool}"));
    }
    let root = tools_root(&app);
    let slot = ToolState::load(&state_file(&app)).slot(&tool);
    let proxy = state.engine.options().proxy;
    let remote = fetch_remote(&tool, proxy.as_deref()).await;

    let mut installed: Vec<ToolVersionItem> = Vec::new();
    for version in slot.installed.iter().rev() {
        let path = version_path(&root, &tool, version);
        if !path.is_file() {
            continue;
        }
        let size = std::fs::metadata(&path).ok().map(|m| m.len());
        installed.push(ToolVersionItem {
            version: version.clone(),
            path: Some(path.to_string_lossy().to_string()),
            size,
            installed: true,
            active: slot.active.as_deref() == Some(version.as_str()),
            released_at: None,
            notes: None,
        });
    }
    // 激活了但没登记（比如用户手动放进来的），也补一条，避免界面显示「未安装」。
    if let Some(active) = slot.active.as_deref() {
        if !installed.iter().any(|i| i.version == active) {
            let path = version_path(&root, &tool, active);
            installed.insert(
                0,
                ToolVersionItem {
                    version: active.to_string(),
                    path: Some(path.to_string_lossy().to_string()),
                    size: std::fs::metadata(&path).ok().map(|m| m.len()),
                    installed: true,
                    active: true,
                    released_at: None,
                    notes: Some("随包内置".into()),
                },
            );
        }
    }

    let installed_versions: Vec<&str> = installed.iter().map(|i| i.version.as_str()).collect();
    let available: Vec<ToolVersionItem> = remote
        .iter()
        .map(|r| ToolVersionItem {
            version: r.version.clone(),
            path: None,
            size: r.size,
            installed: installed_versions.contains(&r.version.as_str()),
            active: slot.active.as_deref() == Some(r.version.as_str()),
            released_at: r.released_at.clone(),
            notes: r.notes.clone(),
        })
        .collect();

    let latest = remote.first().map(|r| r.version.clone());
    let update_available = match (latest.as_deref(), slot.active.as_deref()) {
        (Some(latest), Some(active)) => update::version_is_newer(latest, active),
        (Some(_), None) => true,
        _ => false,
    };

    Ok(ToolVersionList {
        tool: tool.clone(),
        active: slot.active.clone(),
        previous: slot.previous.clone(),
        latest,
        update_available,
        installed,
        available,
        warning: if remote.is_empty() {
            Some("无法连接版本服务，仅显示本地已装版本".into())
        } else {
            None
        },
    })
}

/// 下载指定版本。yt-dlp 单文件；ffmpeg 解压 zip 后只保留 `bin/` 下的文件。
#[tauri::command]
pub async fn tool_install_version(
    app: AppHandle,
    state: State<'_, AppState>,
    tool: String,
    version: String,
) -> Result<ToolVersionItem, String> {
    use futures_util::StreamExt;

    if tool != TOOL_YTDLP && tool != TOOL_FFMPEG {
        return Err(format!("未知工具：{tool}"));
    }
    let root = tools_root(&app);
    std::fs::create_dir_all(&root).map_err(|e| format!("创建工具目录失败：{e}"))?;
    let proxy = state.engine.options().proxy;
    let remote = fetch_remote(&tool, proxy.as_deref()).await;
    let target = remote
        .iter()
        .find(|r| r.version == version)
        .ok_or_else(|| format!("版本服务里没有 {version}，请刷新后重试"))?;

    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600));
    if let Some(proxy) = proxy.as_deref().filter(|p| !p.trim().is_empty()) {
        if let Ok(p) = reqwest::Proxy::all(proxy.trim()) {
            builder = builder.proxy(p);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let tmp = root.join(format!(".download-{tool}-{version}"));
    let resp = client
        .get(&target.url)
        .send()
        .await
        .map_err(|e| format!("下载 {tool} 失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载 {tool} 失败：HTTP {}", resp.status().as_u16()));
    }
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("创建临时文件失败：{e}"))?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("写入失败：{e}"))?;
    }
    drop(file);

    let result = if tool == TOOL_FFMPEG {
        install_ffmpeg_from_zip(&root, &version, &tmp)
    } else {
        let dest = version_path(&root, TOOL_YTDLP, &version);
        std::fs::rename(&tmp, &dest).map_err(|e| format!("保存失败：{e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
        }
        Ok(dest)
    };
    let _ = std::fs::remove_file(&tmp);
    let dest = result?;

    // 下载完必须能跑起来才算装好，否则删掉，别把坏文件留在版本列表里。
    let probed = probe_version(&dest, &tool);
    if probed.is_none() {
        let _ = std::fs::remove_file(&dest);
        return Err(format!(
            "{tool} {version} 下载完成但无法执行，可能不是当前平台的构建"
        ));
    }

    let mut store = ToolState::load(&state_file(&app));
    store.mark_installed(&tool, &version);
    let _ = store.save(&state_file(&app));

    Ok(ToolVersionItem {
        version,
        path: Some(dest.to_string_lossy().to_string()),
        size: std::fs::metadata(&dest).ok().map(|m| m.len()),
        installed: true,
        active: false,
        released_at: target.released_at.clone(),
        notes: target.notes.clone(),
    })
}

fn install_ffmpeg_from_zip(root: &Path, version: &str, zip_path: &Path) -> Result<PathBuf, String> {
    let dir = root.join(format!("ffmpeg-{version}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建版本目录失败：{e}"))?;
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开压缩包失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析压缩包失败：{e}"))?;
    let mut found = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        // BtbN 的包结构是 `<root>/bin/*.{exe,dll}`，只取 bin/ 下的文件平铺出来，
        // 因为 shared 版 ffmpeg.exe 依赖同目录的 avcodec 等 dll。
        if !name.contains("/bin/") || entry.is_dir() {
            continue;
        }
        let Some(base) = name.rsplit('/').next().filter(|s| !s.is_empty()) else {
            continue;
        };
        let out_path = dir.join(base);
        let mut out =
            std::fs::File::create(&out_path).map_err(|e| format!("写入 {base} 失败：{e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压 {base} 失败：{e}"))?;
        if base.eq_ignore_ascii_case(exe_name(TOOL_FFMPEG)) {
            found = true;
        }
    }
    if !found {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("压缩包里没有 ffmpeg.exe".into());
    }
    Ok(dir.join(exe_name(TOOL_FFMPEG)))
}

/// 切换激活版本。会先探测可执行，探测失败拒绝切换——避免把下载功能搞挂。
#[tauri::command]
pub async fn tool_activate_version(
    app: AppHandle,
    state: State<'_, AppState>,
    tool: String,
    version: String,
) -> Result<ToolVersionItem, String> {
    if tool != TOOL_YTDLP && tool != TOOL_FFMPEG {
        return Err(format!("未知工具：{tool}"));
    }
    let root = tools_root(&app);
    let path = version_path(&root, &tool, &version);
    if !path.is_file() {
        return Err(format!("{tool} {version} 还没安装"));
    }
    let probed = probe_version(&path, &tool)
        .ok_or_else(|| format!("{tool} {version} 无法执行，已取消切换"))?;

    let mut options = state.engine.options();
    if tool == TOOL_FFMPEG {
        options.ffmpeg_path = Some(path.to_string_lossy().to_string());
    } else {
        options.yt_dlp_path = path.to_string_lossy().to_string();
    }
    state.engine.set_options(options).await;

    let mut store = ToolState::load(&state_file(&app));
    store.mark_installed(&tool, &version);
    store.activate(&tool, &version);
    let _ = store.save(&state_file(&app));

    Ok(ToolVersionItem {
        version,
        path: Some(path.to_string_lossy().to_string()),
        size: std::fs::metadata(&path).ok().map(|m| m.len()),
        installed: true,
        active: true,
        released_at: None,
        notes: Some(format!("已激活（实测版本 {probed}）")),
    })
}

/// 回滚到上一个激活过的版本。
#[tauri::command]
pub async fn tool_rollback(
    app: AppHandle,
    state: State<'_, AppState>,
    tool: String,
) -> Result<ToolVersionItem, String> {
    let slot = ToolState::load(&state_file(&app)).slot(&tool);
    let previous = slot
        .previous
        .ok_or_else(|| "没有可回滚的历史版本".to_string())?;
    let root = tools_root(&app);
    if !version_path(&root, &tool, &previous).is_file() {
        return Err(format!("上一个版本 {previous} 的文件已不存在"));
    }
    tool_activate_version(app, state, tool, previous).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ytdlp_release_json_extracts_downloadable_versions() {
        let raw = r#"[
            {"tag_name":"2025.11.01","draft":false,"prerelease":false,
             "published_at":"2025-11-01T00:00:00Z",
             "assets":[{"name":"yt-dlp.exe","size":23575744,"browser_download_url":"https://x/a.exe"}]},
            {"tag_name":"2025.10.31","draft":false,"prerelease":false,
             "published_at":"2025-10-31T00:00:00Z",
             "assets":[{"name":"yt-dlp.exe","size":23500000,"browser_download_url":"https://x/b.exe"}]},
            {"tag_name":"2025.10.30","draft":true,
             "assets":[{"name":"yt-dlp.exe","size":1,"browser_download_url":"https://x/c.exe"}]},
            {"tag_name":"2025.10.29","prerelease":true,
             "assets":[{"name":"yt-dlp.exe","size":1,"browser_download_url":"https://x/d.exe"}]}
        ]"#;
        let list = parse_remote(TOOL_YTDLP, raw);
        assert_eq!(list.len(), 2, "草稿和预发布要过滤掉");
        assert_eq!(list[0].version, "2025.11.01");
        assert_eq!(list[0].size, Some(23_575_744));
        assert!(list[0].released_at.is_some());
    }

    #[test]
    fn ffmpeg_release_json_reuses_engine_parser() {
        let raw = r#"{"assets":[
            {"name":"ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip","browser_download_url":"https://x/9.zip","size":73000000},
            {"name":"ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip","browser_download_url":"https://x/8.zip","size":76000000}
        ]}"#;
        let list = parse_remote(TOOL_FFMPEG, raw);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].version, "9.0");
    }

    #[test]
    fn garbage_json_does_not_panic() {
        assert!(parse_remote(TOOL_YTDLP, "<html>404</html>").is_empty());
        assert!(parse_remote(TOOL_FFMPEG, "null").is_empty());
    }

    #[test]
    fn version_paths_are_tool_specific() {
        let root = Path::new("/tmp/tools");
        assert_eq!(
            version_path(root, TOOL_YTDLP, "2025.11.01"),
            PathBuf::from("/tmp/tools/yt-dlp-2025.11.01.exe")
        );
        assert!(version_path(root, TOOL_FFMPEG, "9.0")
            .to_string_lossy()
            .contains("ffmpeg-9.0"));
    }
}
