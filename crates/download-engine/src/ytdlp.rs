//! yt-dlp 自动更新：FluxDL 把 yt-dlp 冻结打包进安装包，但 YouTube 反爬频繁变动，
//! 旧版 yt-dlp 很快就会报「The page needs to be reloaded」这类错误。
//! 本模块在后台定期检查并就地替换随包 yt-dlp，避免每次 YouTube 改版都要重发整个安装包。
//!
//! 设计要点：
//! - 只在 `yt_dlp_path` 指向具体文件（随包内置）时接管更新；PATH 里的系统 yt-dlp 不动。
//! - 进程内 24h 冷却 + 并发互斥，避免每次媒体任务都打 GitHub API。
//! - 任意一步失败（网络/解析/写入）都「维持现状」，绝不让更新失败阻塞正常下载。
//! - 下载地址失败时回退到 ghfast.top 镜像，兼顾国内网络。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

/// 每次媒体任务报错时强制检查（绕过 24h 冷却）的语义标记。
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 3600);
const USER_AGENT: &str = "FluxDL/0.1 (yt-dlp auto-updater)";
const GH_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const MIRROR_PREFIX: &str = "https://ghfast.top/";

struct Guard {
    /// 上次成功完成检查（Updated 或 Unchanged）的时间，用于 24h 冷却。
    last_check: Option<SystemTime>,
    /// 是否有更新正在进行，防止并发媒体任务重复下载。
    updating: bool,
}

static STATE: OnceLock<Mutex<Guard>> = OnceLock::new();

fn guard() -> &'static Mutex<Guard> {
    STATE.get_or_init(|| Mutex::new(Guard { last_check: None, updating: false }))
}

/// 自动更新的结果，供调用方决定是否值得重试一次下载。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateResult {
    /// 刚下载并替换了新版本，可以重试。
    Updated,
    /// 已是最新，无需替换。
    Unchanged,
    /// 用户在设置里关掉了自动更新。
    Disabled,
    /// 网络/解析/写入失败，维持现状。
    Failed,
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// 进程内冷却判断：超过 24h 才允许非强制检查。
fn cooldown_passed() -> bool {
    let g = guard().lock().unwrap();
    match g.last_check {
        None => true,
        Some(t) => {
            SystemTime::now()
                .duration_since(t)
                .unwrap_or(Duration::MAX)
                >= CHECK_INTERVAL
        }
    }
}

fn mark_checked() {
    guard().lock().unwrap().last_check = Some(SystemTime::now());
}

/// 入口：由 Engine 调用。`force=true` 用于「下载报错时立即尝试更新」。
pub async fn update_if_stale(bin_path: &str, enabled: bool, force: bool) -> UpdateResult {
    let path = bin_path.trim();
    // PATH 里的系统 yt-dlp（用户自己维护）或空路径：不接管更新。
    if path.is_empty() || path == "yt-dlp" || path == "yt-dlp.exe" {
        return UpdateResult::Unchanged;
    }
    if !enabled {
        return UpdateResult::Disabled;
    }
    if !force && !cooldown_passed() {
        return UpdateResult::Unchanged;
    }
    // 并发互斥：同一进程只跑一个更新。
    {
        let mut g = guard().lock().unwrap();
        if g.updating {
            return UpdateResult::Unchanged;
        }
        g.updating = true;
    }
    let result = do_update(path).await;
    {
        let mut g = guard().lock().unwrap();
        g.updating = false;
        match result {
            UpdateResult::Updated | UpdateResult::Unchanged => mark_checked(),
            UpdateResult::Failed | UpdateResult::Disabled => {}
        }
    }
    result
}

struct ReleaseInfo {
    tag: String,
    asset_url: String,
}

async fn do_update(bin_path: &str) -> UpdateResult {
    // 1. 当前版本（拿不到也继续，可能是新版改了输出格式）
    let current = current_version(bin_path);
    // 2. 最新发布的版本号与下载地址
    let release = match fetch_latest().await {
        Some(r) => r,
        None => return UpdateResult::Failed,
    };
    let need = match &current {
        Some(c) => is_newer(&release.tag, c),
        None => true,
    };
    if !need {
        return UpdateResult::Unchanged;
    }
    // 3. 下载新二进制
    let bytes = match download(&release.asset_url).await {
        Some(b) => b,
        None => return UpdateResult::Failed,
    };
    // 4. 先备份旧版，再就地替换。任意写入失败都退回现状。
    let target = PathBuf::from(bin_path);
    if let Some(parent) = target.parent() {
        let _ = std::fs::copy(&target, parent.join(format!("{}.bak", target.display())));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 先写到临时名再 rename，规避部分文件系统对正在运行文件的限制。
        let tmp = target.with_extension("new");
        if std::fs::write(&tmp, &bytes).is_err() {
            return UpdateResult::Failed;
        }
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        if std::fs::rename(&tmp, &target).is_err() {
            return UpdateResult::Failed;
        }
    }
    #[cfg(not(unix))]
    {
        if std::fs::write(&target, &bytes).is_err() {
            return UpdateResult::Failed;
        }
    }
    UpdateResult::Updated
}

/// 运行 `yt-dlp --version`，捕获 stdout 里的版本号。
fn current_version(bin_path: &str) -> Option<String> {
    use std::process::Command;
    let out = Command::new(bin_path)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let v = s.lines().next()?.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// 拉取最新发布信息；官方 API 失败则回退镜像。返回 (版本号, 资产下载地址)。
async fn fetch_latest() -> Option<ReleaseInfo> {
    let asset_name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .ok()?;
    for base in [GH_API, &format!("{MIRROR_PREFIX}{GH_API}")] {
        if let Ok(resp) = client.get(base).send().await {
            if let Ok(json) = resp.json::<Release>().await {
                let url = json
                    .assets
                    .iter()
                    .find(|a| a.name == asset_name)
                    .map(|a| a.browser_download_url.clone());
                if let Some(url) = url {
                    return Some(ReleaseInfo {
                        tag: json.tag_name,
                        asset_url: url,
                    });
                }
            }
        }
    }
    None
}

/// 下载资产字节；官方地址失败回退镜像。
async fn download(url: &str) -> Option<Vec<u8>> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(90))
        .build()
        .ok()?;
    for u in [url, &format!("{MIRROR_PREFIX}{url}")] {
        if let Ok(resp) = client.get(u).send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = resp.bytes().await {
                    return Some(bytes.to_vec());
                }
            }
        }
    }
    None
}

/// 版本号比较：yt-dlp 用 `年.月.日` 形式（如 `2025.11.01`）。逐段数值比较，
/// 返回 `latest` 是否严格大于 `current`。
pub fn is_newer(latest: &str, current: &str) -> bool {
    fn parse(v: &str) -> Vec<u32> {
        v.split(['.', '-'])
            .filter_map(|s| s.trim().parse::<u32>().ok())
            .collect()
    }
    let a = parse(latest);
    let b = parse(current);
    if a.is_empty() {
        return false; // 解析不出就别乱更
    }
    if b.is_empty() {
        return true; // 当前版本号拿不到，倾向于更新
    }
    for (x, y) in a.iter().zip(b.iter()) {
        if x != y {
            return x > y;
        }
    }
    a.len() > b.len() // 如 2025.11.01 > 2025.11
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_version_detection() {
        assert!(is_newer("2025.11.01", "2025.10.31"));
        assert!(is_newer("2025.11.01", "2025.11.00"));
        assert!(is_newer("2025.12.01", "2025.11.30"));
        assert!(!is_newer("2025.10.31", "2025.11.01"));
        // 多一段视为更新：2025.11.01 > 2025.11
        assert!(is_newer("2025.11.01", "2025.11"));
        // 解析失败不应误触发更新
        assert!(!is_newer("garbage", "2025.11.01"));
        // 当前解析失败应倾向于更新
        assert!(is_newer("2025.11.01", "not-a-version"));
    }
}
