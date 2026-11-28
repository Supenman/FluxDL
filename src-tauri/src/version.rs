//! 应用本体的版本管理：检查更新、下载进版本库、重启替换、更新历史。
//!
//! 与「整包重下」的区别：这里只下载 `fluxdl.exe` 这一个文件（十几 MB），
//! 直接从版本库取用，不碰安装包。落地流程是：
//!
//! 下载 → 校验 sha256 → 存进 `app-versions\<版本>\fluxdl.exe`
//!      → 用户点「更新」→ 写 `.new` + 状态 → 延迟脚本「备份 → 替换 → 拉起」
//!
//! 任何一步失败都能靠 `fluxdl.exe.bak` 或版本库里的旧版本回滚
//! （见 engine 的 `update::recover` 与 `crate::appversion::boot_guard`）。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use fluxdl_engine::update::{self, UpdateManifest};

use crate::AppState;

const USER_AGENT: &str = "FluxDL/0.1 (update-client)";
/// 清单缓存有效期：6 小时内重复点击「检查更新」不打网络。
const CACHE_TTL_MS: i64 = 6 * 3600 * 1000;

/// 清单来源：Release 附件优先（随版本一起发布），其次仓库 main 的 raw，
/// 最后走加速镜像——国内直连 raw.githubusercontent.com 经常超时。
/// 仓库原名 FuxDL，用户已改名为 FluxDL；旧名只在网页 / API 上重定向，raw 与
/// release 下载直链不保证跟随，因此这里统一写改名后的新名。
const MANIFEST_URLS: &[&str] = &[
    "https://github.com/Supenman/FluxDL/releases/latest/download/update-manifest.json",
    "https://raw.githubusercontent.com/Supenman/FluxDL/main/update-manifest.json",
    "https://ghfast.top/https://raw.githubusercontent.com/Supenman/FluxDL/main/update-manifest.json",
];

fn http_client(
    proxy: Option<&str>,
    use_system_proxy: bool,
    total_timeout_secs: u64,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(total_timeout_secs));
    if let Some(proxy) = proxy.filter(|p| !p.trim().is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy.trim()).map_err(|e| e.to_string())?);
    } else if !use_system_proxy {
        builder = builder.no_proxy();
    }
    // proxy 为空且 use_system_proxy=true 时不设任何代理：reqwest 的 system-proxy
    // feature 自动读 Windows 系统代理，修复「开了 Clash 但更新器直连超时」。
    builder.build().map_err(|e| e.to_string())
}

/// GitHub Release 直链在国内常超时。给出一组镜像候选：把原始 URL 交回网络层顺序尝试，
/// 任一成功即停。镜像只做「GitHub releases/download」路径的前缀替换，不改文件名/版本，
/// 因此每个候选下载的内容完全相同，最终仍由 SHA-256 校验兜底。
fn asset_mirror_urls(primary: &str) -> Vec<String> {
    const PREFIXES: &[&str] = &[
        "", // 原始 GitHub 直链优先
        "https://ghfast.top/",
        "https://gh-proxy.com/",
        "https://ghproxy.net/",
    ];
    let mut out = Vec::with_capacity(PREFIXES.len());
    for prefix in PREFIXES {
        let url = if prefix.is_empty() {
            primary.to_string()
        } else {
            format!("{prefix}{primary}")
        };
        if !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

fn cache_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("update-cache.json")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CachedManifest {
    manifest: Option<UpdateManifest>,
    fetched_at: i64,
    source: String,
}

fn read_cache(app: &AppHandle) -> CachedManifest {
    std::fs::read_to_string(cache_path(app))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_cache(app: &AppHandle, cache: &CachedManifest) {
    let path = cache_path(app);
    let Ok(raw) = serde_json::to_string_pretty(cache) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 缓存写坏了大不了重新联网，不值得让更新流程失败。
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, raw).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// 拉清单：先看缓存，`force` 或过期才联网。多个来源逐个试，全失败才报错。
async fn load_manifest(
    app: &AppHandle,
    proxy: Option<&str>,
    use_system_proxy: bool,
    force: bool,
) -> Result<(UpdateManifest, String), String> {
    let cache = read_cache(app);
    let fresh = update::now_ms() - cache.fetched_at < CACHE_TTL_MS;
    if !force && fresh {
        if let Some(manifest) = cache.manifest.clone() {
            return Ok((manifest, cache.source));
        }
    }

    let client = http_client(proxy, use_system_proxy, 30)?;
    let mut last_error = String::from("所有更新源都不可达");
    for url in MANIFEST_URLS {
        match client.get(*url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(text) => match UpdateManifest::parse(&text) {
                    Ok(manifest) => {
                        write_cache(
                            app,
                            &CachedManifest {
                                manifest: Some(manifest.clone()),
                                fetched_at: update::now_ms(),
                                source: (*url).to_string(),
                            },
                        );
                        return Ok((manifest, (*url).to_string()));
                    }
                    Err(err) => last_error = err,
                },
                Err(err) => last_error = format!("读取更新清单失败：{err}"),
            },
            Ok(resp) => last_error = format!("更新源返回 HTTP {}", resp.status().as_u16()),
            Err(err) => last_error = format!("连接更新源失败：{err}"),
        }
    }
    // 全挂了但手里有旧缓存：给用户一个可用的历史与版本信息，别再报红。
    if let Some(manifest) = cache.manifest.clone() {
        return Ok((manifest, format!("{}（离线缓存）", cache.source)));
    }
    Err(last_error)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub version: String,
    pub released_at: String,
    pub channel: Option<String>,
    pub notes: Vec<String>,
}

fn history_of(manifest: &UpdateManifest) -> Vec<HistoryItem> {
    manifest
        .history
        .iter()
        .map(|item| HistoryItem {
            version: item.version.clone(),
            released_at: item.released_at.clone(),
            channel: item.channel.clone(),
            notes: item.notes.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersionInfo {
    pub app_version: String,
    pub engine_version: String,
    pub platform: String,
    pub install_dir: String,
    /// 便携版：exe 旁边就有 tools/，卸载等于删文件夹。
    pub portable: bool,
}

#[tauri::command]
pub fn app_version_info(app: AppHandle) -> AppVersionInfo {
    let exe = std::env::current_exe().unwrap_or_default();
    let install_dir = exe
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let portable = exe
        .parent()
        .map(|p| p.join("tools").is_dir() && p.join("browser-extension").is_dir())
        .unwrap_or(false);
    AppVersionInfo {
        app_version: app.package_info().version.to_string(),
        engine_version: fluxdl_engine::ENGINE_VERSION.to_string(),
        platform: update::platform_key().to_string(),
        install_dir,
        portable,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current: String,
    pub latest: String,
    pub available: bool,
    /// 当前版本低于清单里的最低支持版本，必须更新才能继续用。
    pub forced: bool,
    pub released_at: String,
    pub notes: Vec<String>,
    pub size: Option<u64>,
    pub platform: String,
    pub source: String,
    pub checked_at: i64,
    pub history: Vec<HistoryItem>,
    /// 检查失败的原因；失败时 `available` 为 false，但历史仍可能是缓存里的。
    pub error: Option<String>,
}

/// 检查更新。网络失败不抛异常——「检查不到」是常态，界面要能安静降级。
#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let opts = state.engine.options();
    let result = load_manifest(
        &app,
        opts.proxy.as_deref(),
        opts.use_system_proxy,
        force.unwrap_or(false),
    )
    .await;

    match result {
        Ok((manifest, source)) => {
            let asset = manifest.app_asset().ok();
            Ok(UpdateCheck {
                current: current.clone(),
                latest: manifest.app.latest.clone(),
                available: manifest.is_app_newer(&current),
                forced: manifest.is_below_min(&current),
                released_at: manifest.app.released_at.clone(),
                notes: manifest.app.notes.clone(),
                size: asset.and_then(|a| a.size),
                platform: update::platform_key().to_string(),
                source,
                checked_at: update::now_ms(),
                history: history_of(&manifest),
                error: None,
            })
        }
        Err(err) => Ok(UpdateCheck {
            current: current.clone(),
            latest: current,
            available: false,
            forced: false,
            released_at: String::new(),
            notes: Vec::new(),
            size: None,
            platform: update::platform_key().to_string(),
            source: String::new(),
            checked_at: update::now_ms(),
            history: Vec::new(),
            error: Some(err),
        }),
    }
}

/// 更新历史。优先联网，失败用缓存，再失败返回空列表（不报错）。
#[tauri::command]
pub async fn app_update_history(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryItem>, String> {
    let opts = state.engine.options();
    match load_manifest(&app, opts.proxy.as_deref(), opts.use_system_proxy, false).await {
        Ok((manifest, _)) => Ok(history_of(&manifest)),
        Err(_) => Ok(history_of(&read_cache(&app).manifest.unwrap_or_default())),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdate {
    pub version: String,
    pub size: u64,
    pub staged_path: String,
    /// Windows 上运行中的 exe 不能自我覆盖，必须重启由脚本替换。
    pub needs_restart: bool,
    /// 本次更新是否同步覆盖了浏览器扩展资产（可选，旧版本缺省）。
    pub extension_updated: bool,
}

/// 下载并暂存新版本。只写 `fluxdl.exe.new`，不动正在运行的 exe。
#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StagedUpdate, String> {
    use futures_util::StreamExt;

    let current = app.package_info().version.to_string();
    let opts = state.engine.options();
    let proxy = opts.proxy.clone();
    let use_system_proxy = opts.use_system_proxy;
    drop(opts);
    let (manifest, _) = load_manifest(&app, proxy.as_deref(), use_system_proxy, false).await?;
    if !manifest.is_app_newer(&current) {
        return Err("当前已是最新版本".into());
    }
    let asset = manifest.app_asset()?.clone();
    // 一律下到版本库里：<app-versions>\<版本>\fluxdl.exe.download。
    // 好处是「下载」和「应用」彻底解耦 —— 下完不点更新也不会污染正在跑的文件，
    // 校验通过后 rename 成正式槽位，随时可切过去或切回来。
    let dir = crate::appversion::versions_root(&app);
    let slot = dir.join(&manifest.app.latest);
    std::fs::create_dir_all(&slot).map_err(|e| format!("创建版本目录失败：{e}"))?;
    let staged = slot.join("fluxdl.exe.download");
    let _ = std::fs::remove_file(&staged);

    // exe 约 10MB，慢网/镜像下 30s 总超时容易误杀；这里放宽到 5 分钟。
    let client = http_client(proxy.as_deref(), use_system_proxy, 300)?;
    let candidates = asset_mirror_urls(&asset.url);
    let mut last_error = String::from("所有下载源都不可用");
    let mut downloaded = 0u64;

    // GitHub 直链与镜像逐个尝试：任一源「下载成功 + SHA-256 校验通过」才算完成。
    // 每个候选都从零重建暂存文件，避免上一个源的半截字节污染下一个。
    for (idx, url) in candidates.iter().enumerate() {
        if idx > 0 {
            let _ = app.emit(
                "update:progress",
                UpdateProgress {
                    phase: "retry".into(),
                    downloaded: 0,
                    total: asset.size.unwrap_or(0),
                },
            );
        }
        let _ = std::fs::remove_file(&staged);

        let attempt = async {
            let resp = client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("连接失败：{e}"))?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status().as_u16()));
            }
            let total = resp.content_length().or(asset.size).unwrap_or(0);
            let mut file = tokio::fs::File::create(&staged)
                .await
                .map_err(|e| format!("创建暂存文件失败：{e}"))?;
            let mut got = 0u64;
            let mut last_emit = std::time::Instant::now();
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
                tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                    .await
                    .map_err(|e| format!("写入暂存文件失败：{e}"))?;
                got += chunk.len() as u64;
                if last_emit.elapsed().as_millis() >= 150 {
                    last_emit = std::time::Instant::now();
                    let _ = app.emit(
                        "update:progress",
                        UpdateProgress {
                            phase: "download".into(),
                            downloaded: got,
                            total,
                        },
                    );
                }
            }
            drop(file);
            Ok::<u64, String>(got)
        }
        .await;

        match attempt {
            Ok(got) => {
                downloaded = got;
                let _ = app.emit(
                    "update:progress",
                    UpdateProgress {
                        phase: "verify".into(),
                        downloaded: got,
                        total: got.max(asset.size.unwrap_or(0)),
                    },
                );
                match update::verify_file(&staged, &asset) {
                    Ok(()) => {
                        let _ = idx;
                        break; // 校验通过，采用该源
                    }
                    Err(err) => last_error = format!("{url} 校验失败：{err}"),
                }
            }
            Err(err) => last_error = format!("{url} {err}"),
        }
    }

    // 循环结束仍未通过校验：此时 staged 里是最后一个源的失败产物，必须删掉。
    if update::verify_file(&staged, &asset).is_err() {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("下载更新失败：{last_error}"));
    }

    // 校验通过才登记成版本，并把 pending 指向它；真正的替换发生在用户点「更新」时。
    let installed = crate::appversion::install_version_file(&app, &staged, &manifest.app.latest)?;
    // 只保留最近几个版本，避免目录无限膨胀（失败不影响更新本身）。
    let _ = crate::appversion::prune_versions(&app, crate::appversion::KEEP_VERSIONS);
    let extension_updated = match manifest.extension.as_ref() {
        Some(ext) => sync_extension_asset(&app, &client, ext).await.unwrap_or(false),
        None => false,
    };
    let _ = current;
    Ok(StagedUpdate {
        version: manifest.app.latest,
        size: downloaded,
        staged_path: installed.to_string_lossy().to_string(),
        needs_restart: true,
        extension_updated,
    })
}

/// 定位可写的本地 `browser-extension` 目录（优先安装目录/便携目录）。
fn writable_extension_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let dir = resource_dir.join("browser-extension");
        if dir.exists() {
            return Some(dir);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let direct = parent.join("browser-extension");
            if direct.exists() {
                return Some(direct);
            }
            // 版本库运行（<root>/app-versions/<ver>/fluxdl.exe）向上查找 <root>/browser-extension
            let mut up = parent.to_path_buf();
            for _ in 0..3 {
                if let Some(p) = up.parent() {
                    up = p.to_path_buf();
                    let cand = up.join("browser-extension");
                    if cand.exists() {
                        return Some(cand);
                    }
                }
            }
        }
    }
    app.path()
        .resource_dir()
        .ok()
        .map(|d| d.join("browser-extension"))
}

/// 若更新清单带 `extension` 资产且本地 SHA-256 标记不一致，自动下载校验并安全覆盖
/// 本地 `browser-extension/` 目录（防 Zip-Slip 路径穿越）。失败不阻断主程序更新。
async fn sync_extension_asset(
    app: &AppHandle,
    client: &reqwest::Client,
    ext: &update::ExtensionRelease,
) -> Result<bool, String> {
    if ext.asset.url.trim().is_empty() {
        return Ok(false);
    }
    let Some(target_dir) = writable_extension_dir(app) else {
        return Ok(false);
    };
    let stamp_path = target_dir.join(".fluxdl-ext.sha256");
    if let Some(expected_sha) = ext.asset.sha256.as_deref() {
        if let Ok(current_sha) = std::fs::read_to_string(&stamp_path) {
            if current_sha.trim().eq_ignore_ascii_case(expected_sha.trim()) {
                return Ok(false);
            }
        }
    }

    let tmp_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取数据目录：{e}"))?;
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let zip_tmp = tmp_dir.join("fluxdl-extension.zip.download");
    let _ = std::fs::remove_file(&zip_tmp);

    let candidates = asset_mirror_urls(&ext.asset.url);
    let mut verified = false;
    let mut last_err = String::from("扩展下载源均不可用");
    for url in &candidates {
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                Ok(bytes) => {
                    if std::fs::write(&zip_tmp, &bytes).is_ok() {
                        match update::verify_file(&zip_tmp, &ext.asset) {
                            Ok(()) => {
                                verified = true;
                                break;
                            }
                            Err(e) => last_err = format!("扩展包校验失败：{e}"),
                        }
                    }
                }
                Err(e) => last_err = format!("读取扩展包失败：{e}"),
            },
            Ok(resp) => last_err = format!("HTTP {}", resp.status().as_u16()),
            Err(e) => last_err = e.to_string(),
        }
    }
    if !verified {
        let _ = std::fs::remove_file(&zip_tmp);
        return Err(last_err);
    }

    let zip_for_extract = zip_tmp.clone();
    let dest = target_dir.clone();
    let extract_res = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dest).map_err(|e| format!("创建扩展目录失败：{e}"))?;
        let f = std::fs::File::open(&zip_for_extract).map_err(|e| format!("打开扩展包失败：{e}"))?;
        let mut archive = zip::ZipArchive::new(f).map_err(|e| format!("解析扩展 zip 失败：{e}"))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("读取扩展条目失败：{e}"))?;
            let Some(enclosed) = entry.enclosed_name() else {
                continue;
            };
            // 兼容打包时是否包含顶层 `browser-extension/` 目录
            let rel = enclosed
                .strip_prefix("browser-extension")
                .unwrap_or(&enclosed);
            if rel.as_os_str().is_empty() {
                continue;
            }
            let out_path = dest.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out_path).map_err(|e| format!("创建扩展子目录失败：{e}"))?;
            } else {
                if let Some(p) = out_path.parent() {
                    std::fs::create_dir_all(p).map_err(|e| format!("创建扩展父目录失败：{e}"))?;
                }
                let mut out = std::fs::File::create(&out_path)
                    .map_err(|e| format!("写入扩展文件失败：{e}"))?;
                std::io::copy(&mut entry, &mut out)
                    .map_err(|e| format!("解压扩展文件失败：{e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("扩展解压任务异常：{e}"))?;

    let _ = std::fs::remove_file(&zip_tmp);
    extract_res?;

    if let Some(sha) = ext.asset.sha256.as_deref() {
        let _ = std::fs::write(&stamp_path, sha.trim());
    }
    Ok(true)
}

/// 让暂存的新版本生效：Unix 直接换文件，Windows 交给延迟脚本并退出进程。
#[tauri::command]
pub fn apply_app_update_and_restart(app: AppHandle) -> Result<String, String> {
    let version = crate::appversion::pending_version(&app)
        .ok_or_else(|| "没有待应用的版本，请先下载更新".to_string())?;
    // 准备 .new、写状态、生成延迟脚本。脚本会等本进程退出后再动文件，
    // 所以下面必须真的 exit —— 否则替换永远等不到。
    let message = crate::appversion::apply_from_library(&app, &version)?;
    app.exit(0);
    Ok(message)
}

/// 启动时收尾上次没走完的替换，返回需要提示给用户的结果。
pub fn recover_on_startup(app: &AppHandle) -> Option<String> {
    let data_dir = app.path().app_data_dir().ok()?;
    let target = std::env::current_exe().ok()?;
    match update::recover(&data_dir, &target) {
        update::Recovery::Nothing => None,
        update::Recovery::Committed => None, // 由 boot_guard 的 pending 逻辑统一提示
        update::Recovery::Aborted => Some("上次更新没有执行完成，仍在使用原版本，请重新点更新。".into()),
        update::Recovery::RolledBack(reason) => Some(format!("更新未完成，已回滚：{reason}")),
    }
}

/// 启动提示只吐一次：前端启动时取走，之后清空，避免每次切页面都弹。
static STARTUP_NOTICE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn set_startup_notice(notice: Option<String>) {
    if let Ok(mut slot) = STARTUP_NOTICE.lock() {
        *slot = notice;
    }
}

#[tauri::command]
pub fn take_startup_notice() -> Option<String> {
    STARTUP_NOTICE.lock().ok().and_then(|mut slot| slot.take())
}

#[allow(dead_code)]
fn ensure_parent(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}
