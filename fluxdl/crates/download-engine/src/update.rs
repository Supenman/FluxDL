//! 版本管理核心：语义化版本、更新清单、按组件增量替换与失败自动回滚。
//!
//! 为什么不直接用 Tauri updater：
//! - 官方 updater 只能整包替换（下载完整安装包），而 FluxDL 的体积大头是 `tools/`
//!   里的 yt-dlp 与 ffmpeg，几十 MB 每次全量重下不划算；
//! - 这里按「组件」替换：应用壳只换 `fluxdl.exe`（十几 MB），工具各换各的，
//!   而且每次替换前先留 `.bak`，启动时校验不通过就自动回滚。
//!
//! 模块只依赖 std + serde + sha2，不碰 Tauri，方便单测。

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// 语义化版本
// ---------------------------------------------------------------------------

/// 语义化版本 `MAJOR.MINOR.PATCH[-prerelease][+build]`。
/// 解析时允许缺段（`0.2` 视为 `0.2.0`），因为工具版本形态不一（yt-dlp 是 `2025.11.01`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<String>,
}

impl Version {
    pub fn parse(raw: &str) -> Option<Self> {
        let text = raw.trim().trim_start_matches('v');
        // 丢弃 build 元数据：semver 规定它不参与比较。
        let text = text.split('+').next().unwrap_or(text);
        let (core, pre) = match text.split_once('-') {
            Some((c, p)) if !p.is_empty() => (c, Some(p.to_string())),
            _ => (text, None),
        };
        let mut parts = core.split('.');
        let major = parts.next()?.parse::<u64>().ok()?;
        let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        // 还剩多余的段就当作非法，避免把 `1.2.3.4` 静默截断。
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            major,
            minor,
            patch,
            pre,
        })
    }

    /// `self` 是否比 `other` 新。预发布版本小于同号正式版。
    pub fn is_newer_than(&self, other: &Self) -> bool {
        use std::cmp::Ordering;
        let head = (self.major, self.minor, self.patch).cmp(&(
            other.major,
            other.minor,
            other.patch,
        ));
        match head {
            Ordering::Greater => true,
            Ordering::Less => false,
            Ordering::Equal => cmp_prerelease(self.pre.as_deref(), other.pre.as_deref())
                == Ordering::Greater,
        }
    }
}

/// 预发布段比较：无预发布 > 有预发布；逐段比较，数字段按数值、其余按字典序，
/// 且数字段优先级低于字母段（semver 第 11 条）。
fn cmp_prerelease(a: Option<&str>, b: Option<&str>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => {
            let xs: Vec<&str> = x.split('.').collect();
            let ys: Vec<&str> = y.split('.').collect();
            for (l, r) in xs.iter().zip(ys.iter()) {
                let order = match (l.parse::<u64>(), r.parse::<u64>()) {
                    (Ok(ln), Ok(rn)) => ln.cmp(&rn),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => l.cmp(r),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
            xs.len().cmp(&ys.len())
        }
    }
}

/// 宽松版本比较：任一侧解析失败时，退化为「逐段数值比较」（yt-dlp 风格日期版本）。
/// 两侧都解析成非法版本则返回 false，避免误触发更新。
pub fn version_is_newer(latest: &str, current: &str) -> bool {
    match (Version::parse(latest), Version::parse(current)) {
        (Some(l), Some(c)) => l.is_newer_than(&c),
        _ => fallback_is_newer(latest, current),
    }
}

fn fallback_is_newer(latest: &str, current: &str) -> bool {
    fn parse(v: &str) -> Vec<u64> {
        v.split(['.', '-', '_'])
            .filter_map(|s| s.trim().parse::<u64>().ok())
            .collect()
    }
    let a = parse(latest);
    let b = parse(current);
    if a.is_empty() {
        return false;
    }
    if b.is_empty() {
        return true;
    }
    for (x, y) in a.iter().zip(b.iter()) {
        if x != y {
            return x > y;
        }
    }
    a.len() > b.len()
}

// ---------------------------------------------------------------------------
// 更新清单
// ---------------------------------------------------------------------------

/// 更新清单：一个 JSON 同时描述应用本体、随包工具与更新历史。
/// 发布流程产出它，客户端只读它——版本号、体积、sha256、更新说明全在一处。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateManifest {
    /// 清单格式版本，便于以后兼容演进；当前为 1。
    pub schema: u32,
    pub app: AppRelease,
    pub tools: BTreeMap<String, ToolRelease>,
    /// 更新历史，按版本从新到旧。
    pub history: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppRelease {
    pub latest: String,
    /// 低于这个版本必须强制更新（协议或数据格式不兼容）。
    pub min_supported: Option<String>,
    pub released_at: String,
    pub notes: Vec<String>,
    /// key 为平台标识，如 `windows-x64`。
    pub assets: BTreeMap<String, Asset>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolRelease {
    pub latest: String,
    pub versions: Vec<ToolVersion>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolVersion {
    pub version: String,
    pub released_at: Option<String>,
    pub notes: Option<String>,
    pub assets: BTreeMap<String, Asset>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Asset {
    pub url: String,
    pub size: Option<u64>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryEntry {
    pub version: String,
    pub released_at: String,
    pub channel: Option<String>,
    pub notes: Vec<String>,
}

/// 当前平台在清单里的 key。
pub fn platform_key() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64")) {
        "windows-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else {
        "unknown"
    }
}

impl UpdateManifest {
    /// 解析清单文本。
    pub fn parse(text: &str) -> Result<Self, String> {
        serde_json::from_str::<Self>(text).map_err(|e| format!("更新清单格式错误：{e}"))
    }

    /// 取当前平台的资产。清单里没有就报错，避免「以为在下载、其实下的是别的平台」。
    pub fn app_asset(&self) -> Result<&Asset, String> {
        let key = platform_key();
        self.app
            .assets
            .get(key)
            .or_else(|| self.app.assets.get("any"))
            .ok_or_else(|| format!("更新清单里没有当前平台（{key}）的安装包"))
    }

    /// 目标版本是否比当前新。
    pub fn is_app_newer(&self, current: &str) -> bool {
        !self.app.latest.is_empty() && version_is_newer(&self.app.latest, current)
    }

    /// 当前版本是否已低于最低支持版本（必须更新）。
    pub fn is_below_min(&self, current: &str) -> bool {
        match self.app.min_supported.as_deref() {
            Some(min) if !min.is_empty() => version_is_newer(min, current),
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// 校验与替换
// ---------------------------------------------------------------------------

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 流式计算文件 sha256：ffmpeg 包有几十 MB，不能整个读进内存。
pub fn file_sha256(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return None,
        }
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

/// 校验下载到本地的文件。清单缺 sha256 一律拒绝——宁可更不了，也不能换上未知文件。
pub fn verify_file(path: &Path, asset: &Asset) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取更新文件失败：{e}"))?;
    if let Some(size) = asset.size {
        if meta.len() != size {
            return Err(format!(
                "更新文件大小不符：期望 {size} 字节，实际 {} 字节（可能下载不完整）",
                meta.len()
            ));
        }
    }
    let expect = asset
        .sha256
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "更新清单缺少 sha256，为安全起见已取消更新".to_string())?;
    let actual = file_sha256(path).ok_or_else(|| "无法计算更新文件校验和".to_string())?;
    if !actual.eq_ignore_ascii_case(expect) {
        return Err(format!(
            "更新文件校验失败，已放弃安装：期望 {expect}，实际 {actual}"
        ));
    }
    Ok(())
}

/// 暂存文件名：`fluxdl.exe.new`。
pub fn staged_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".new");
    target.with_file_name(name)
}

/// 备份文件名：`fluxdl.exe.bak`。
pub fn backup_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    target.with_file_name(name)
}

pub fn state_path(dir: &Path) -> PathBuf {
    dir.join("update-state.json")
}

/// 一次替换的现场记录。写在磁盘上，用于「换到一半进程挂了」的恢复。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SwapState {
    pub component: String,
    pub from_version: String,
    pub to_version: String,
    pub target: String,
    pub backup: String,
    pub staged: String,
    pub expect_sha256: String,
    pub started_at: i64,
}

pub fn write_state(dir: &Path, state: &SwapState) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建状态目录失败：{e}"))?;
    let path = state_path(dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("写入更新状态失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("提交更新状态失败：{e}"))
}

pub fn read_state(dir: &Path) -> Option<SwapState> {
    let raw = std::fs::read_to_string(state_path(dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn clear_state(dir: &Path) {
    let _ = std::fs::remove_file(state_path(dir));
}

/// 就地替换：先备份，再 rename。Unix 下对正在运行的文件也成立；
/// Windows 下替换运行中的 exe 会失败，走 `apply_script` 的延迟替换。
pub fn swap_in_place(target: &Path) -> Result<(), String> {
    let staged = staged_path(target);
    if !staged.is_file() {
        return Err("暂存文件不存在，可能已被清理".into());
    }
    let backup = backup_path(target);
    if target.is_file() {
        std::fs::copy(target, &backup).map_err(|e| format!("备份旧版本失败：{e}"))?;
    }
    std::fs::rename(&staged, target).map_err(|e| format!("替换文件失败：{e}"))
}

/// 回滚：用备份覆盖回主文件。备份不存在时返回错误，由调用方决定后续。
pub fn restore_backup(target: &Path) -> Result<(), String> {
    let backup = backup_path(target);
    if !backup.is_file() {
        return Err("没有可用的备份文件".into());
    }
    std::fs::copy(&backup, target).map_err(|e| format!("回滚失败：{e}"))?;
    Ok(())
}

/// 恢复结论，用于写日志与前端提示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recovery {
    /// 替换其实已经成功，只是状态文件没来得及清。
    Committed,
    /// 判定失败并回滚（附原因）。
    RolledBack(String),
    /// 没有待处理的替换。
    Nothing,
}

/// 启动时调用：把上次没走完的替换收尾。这是「失败自动回滚」的落点。
///
/// 判定顺序：
/// 1. 主文件 sha256 == 期望 → 替换成功，清理现场；
/// 2. 主文件不存在 → 用备份恢复（替换到一半断电）；
/// 3. 主文件 sha256 不符 → 用备份覆盖回旧版；
/// 4. 连备份都没有 → 保持现状，清掉状态，交给上层报错。
pub fn recover(dir: &Path, target: &Path) -> Recovery {
    let Some(state) = read_state(dir) else {
        return Recovery::Nothing;
    };
    let backup = backup_path(target);
    let staged = staged_path(target);

    let matched = file_sha256(target)
        .map(|actual| actual.eq_ignore_ascii_case(state.expect_sha256.trim()))
        .unwrap_or(false);

    if matched {
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::remove_file(&staged);
        clear_state(dir);
        return Recovery::Committed;
    }

    let reason = if !target.is_file() {
        "主程序文件缺失，已用备份恢复"
    } else if backup.is_file() {
        "新版本校验不通过，已回滚到上一版本"
    } else {
        "新版本校验不通过，且没有备份可用"
    };

    if backup.is_file() {
        if let Err(err) = restore_backup(target) {
            clear_state(dir);
            return Recovery::RolledBack(format!("回滚未完成：{err}"));
        }
    }
    let _ = std::fs::remove_file(&staged);
    clear_state(dir);
    Recovery::RolledBack(reason.to_string())
}

/// Windows 延迟替换脚本：等旧进程退出 → 备份 → 换上新文件 → 拉起新进程 → 自删。
///
/// 用 `ping` 而不是 `timeout` 做延迟：`timeout` 在没控制台的会话里会直接报错。
/// 路径一律用绝对路径拼进命令，不依赖 `cd`——脚本由别的进程拉起时工作目录不可信。
pub fn apply_script(target: &Path, relaunch_args: &[String]) -> String {
    let exe = target.to_string_lossy().to_string();
    let staged = format!("{exe}.new");
    let backup = format!("{exe}.bak");
    let args = relaunch_args.join(" ");
    format!(
        "@echo off\r\n\
         chcp 65001 >nul\r\n\
         rem 等旧进程彻底退出，否则文件仍被占用\r\n\
         ping -n 4 127.0.0.1 >nul\r\n\
         if exist \"{exe}\" move /y \"{exe}\" \"{backup}\" >nul 2>&1\r\n\
         move /y \"{staged}\" \"{exe}\" >nul 2>&1\r\n\
         if not exist \"{exe}\" (\r\n\
         \x20 rem 替换失败：把备份还原回去，保证还能启动\r\n\
         \x20 if exist \"{backup}\" move /y \"{backup}\" \"{exe}\" >nul 2>&1\r\n\
         )\r\n\
         start \"\" \"{exe}\" {args}\r\n\
         del \"%~f0\"\r\n",
        exe = exe,
        staged = staged,
        backup = backup,
        args = args,
    )
}

// ---------------------------------------------------------------------------
// 工具（yt-dlp / ffmpeg）版本选择
// ---------------------------------------------------------------------------

/// 工具槽位：记录装过哪些版本、当前用哪个、上一个是谁（供一键回滚）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolSlot {
    pub active: Option<String>,
    pub previous: Option<String>,
    pub installed: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolState {
    pub tools: BTreeMap<String, ToolSlot>,
}

impl ToolState {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, raw).map_err(|e| format!("写入工具状态失败：{e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("提交工具状态失败：{e}"))
    }

    pub fn slot(&self, tool: &str) -> ToolSlot {
        self.tools.get(tool).cloned().unwrap_or_default()
    }

    /// 记一次激活：旧 active 变成 previous，版本号去重后进 installed。
    pub fn activate(&mut self, tool: &str, version: &str) {
        let slot = self.tools.entry(tool.to_string()).or_default();
        if slot.active.as_deref() == Some(version) {
            return;
        }
        slot.previous = slot.active.take();
        slot.active = Some(version.to_string());
        if !slot.installed.iter().any(|v| v == version) {
            slot.installed.push(version.to_string());
        }
    }

    /// 记一次安装（未激活）。
    pub fn mark_installed(&mut self, tool: &str, version: &str) {
        let slot = self.tools.entry(tool.to_string()).or_default();
        if !slot.installed.iter().any(|v| v == version) {
            slot.installed.push(version.to_string());
        }
    }
}

/// 从 GitHub releases 响应里提取 (版本号, 资产下载地址)，按发布顺序（新→旧）。
///
/// 只认带 `asset_name` 的那一条，避免把源码包当成可执行文件。
pub fn parse_github_releases(json: &str, asset_name: &str) -> Vec<(String, String)> {
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for release in list {
        let tag = release
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if tag.is_empty() {
            continue;
        }
        let Some(assets) = release.get("assets").and_then(|v| v.as_array()) else {
            continue;
        };
        let url = assets.iter().find_map(|asset| {
            let name = asset.get("name").and_then(|v| v.as_str())?;
            if name != asset_name {
                return None;
            }
            asset
                .get("browser_download_url")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
        if let Some(url) = url {
            out.push((tag.trim_start_matches('v').to_string(), url));
        }
    }
    out
}

/// 从 BtbN/FFmpeg-Builds 的 release 里提取可选的 ffmpeg 版本。
///
/// 资产名形如 `ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip`：取 `-shared` 变体，
/// 体积只有完整版的一半（73 MB vs 186 MB），解压后 dll 与 exe 同目录即可运行。
pub fn parse_ffmpeg_versions(json: &str) -> Vec<(String, String, Option<u64>)> {
    let Ok(release) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(assets) = release.get("assets").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String, Option<u64>)> = Vec::new();
    for asset in assets {
        let Some(name) = asset.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if !name.starts_with("ffmpeg-n")
            || !name.contains("win64-lgpl-shared")
            || !name.ends_with(".zip")
        {
            continue;
        }
        // ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip → 9.0
        let Some(version) = name.rsplit('-').next().map(|s| s.trim_end_matches(".zip")) else {
            continue;
        };
        if version.is_empty() {
            continue;
        }
        let Some(url) = asset.get("browser_download_url").and_then(|v| v.as_str()) else {
            continue;
        };
        if out.iter().any(|(v, _, _)| v == version) {
            continue;
        }
        out.push((
            version.to_string(),
            url.to_string(),
            asset.get("size").and_then(|v| v.as_u64()),
        ));
    }
    // 降序：新的在前
    out.sort_by(|a, b| {
        if version_is_newer(&a.0, &b.0) {
            std::cmp::Ordering::Less
        } else if version_is_newer(&b.0, &a.0) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    out
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fluxdl-upd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn semver_ordering_follows_spec() {
        // 主次修订
        assert!(version_is_newer("0.2.0", "0.1.9"));
        assert!(version_is_newer("1.0.0", "0.99.99"));
        assert!(!version_is_newer("0.1.0", "0.1.0"));
        // 预发布小于正式版
        assert!(version_is_newer("0.2.0", "0.2.0-beta.1"));
        assert!(!version_is_newer("0.2.0-beta.1", "0.2.0"));
        // 预发布内部：数字段数值比较，beta.10 > beta.9
        assert!(version_is_newer("0.2.0-beta.10", "0.2.0-beta.9"));
        assert!(version_is_newer("0.2.0-beta", "0.2.0-alpha"));
        // 缺段按 0 补齐
        assert!(version_is_newer("0.2", "0.1.5"));
        // build 元数据不参与比较
        assert!(!version_is_newer("0.2.0+abc", "0.2.0+def"));
        // 非法输入不当作更新
        assert!(!version_is_newer("garbage", "0.2.0"));
    }

    #[test]
    fn loose_version_falls_back_to_numeric_segments() {
        // 日期型版本（yt-dlp）
        assert!(fallback_is_newer("2025.11.01", "2025.10.31"));
        assert!(!fallback_is_newer("2025.10.31", "2025.11.01"));
        // 解析成 semver 也成立
        assert!(version_is_newer("2025.11.01", "2025.10.31"));
    }

    #[test]
    fn manifest_picks_platform_asset_and_gates_min_version() {
        let raw = r#"{
            "schema": 1,
            "app": {
                "latest": "0.2.0",
                "minSupported": "0.1.5",
                "releasedAt": "2026-11-06T00:00:00Z",
                "notes": ["新增版本管理"],
                "assets": {
                    "windows-x64": {"url": "https://example.com/fluxdl-0.2.0.exe", "size": 12, "sha256": "abc"}
                }
            },
            "tools": {
                "yt-dlp": {"latest": "2025.11.01", "versions": []}
            },
            "history": [
                {"version": "0.2.0", "releasedAt": "2026-11-06T00:00:00Z", "notes": ["a"]},
                {"version": "0.1.0", "releasedAt": "2026-10-20T00:00:00Z", "notes": ["b"]}
            ]
        }"#;
        let manifest = UpdateManifest::parse(raw).unwrap();
        assert_eq!(manifest.history.len(), 2);
        assert_eq!(manifest.tools["yt-dlp"].latest, "2025.11.01");
        assert!(manifest.is_app_newer("0.1.0"));
        assert!(!manifest.is_app_newer("0.2.0"));
        assert!(manifest.is_below_min("0.1.0"));
        assert!(!manifest.is_below_min("0.1.5"));
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert!(manifest.app_asset().is_ok());
        }
    }

    #[test]
    fn verify_rejects_size_or_hash_mismatch_and_missing_hash() {
        let dir = temp_dir("verify");
        let file = dir.join("payload.bin");
        std::fs::write(&file, b"hello-fluxdl").unwrap();
        let good = sha256_hex(b"hello-fluxdl");

        let ok = Asset {
            url: String::new(),
            size: Some(12),
            sha256: Some(good.clone()),
        };
        assert!(verify_file(&file, &ok).is_ok());

        let bad_size = Asset {
            size: Some(99),
            sha256: Some(good.clone()),
            ..Default::default()
        };
        assert!(verify_file(&file, &bad_size).unwrap_err().contains("大小不符"));

        let bad_hash = Asset {
            size: None,
            sha256: Some("deadbeef".into()),
            ..Default::default()
        };
        assert!(verify_file(&file, &bad_hash).unwrap_err().contains("校验失败"));

        // 缺 sha256：宁可更不了，也不装未知文件
        let no_hash = Asset {
            size: None,
            sha256: None,
            ..Default::default()
        };
        assert!(verify_file(&file, &no_hash).unwrap_err().contains("缺少 sha256"));
    }

    #[test]
    fn swap_keeps_backup_and_rollback_restores_bytes() {
        let dir = temp_dir("swap");
        let target = dir.join("fluxdl.exe");
        std::fs::write(&target, b"OLD-BINARY").unwrap();
        std::fs::write(staged_path(&target), b"NEW-BINARY").unwrap();

        swap_in_place(&target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"NEW-BINARY");
        assert_eq!(
            std::fs::read(backup_path(&target)).unwrap(),
            b"OLD-BINARY",
            "备份必须保留旧版本，否则无从回滚"
        );

        restore_backup(&target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"OLD-BINARY");
    }

    #[test]
    fn recover_reports_rolled_back_when_new_binary_is_wrong() {
        let dir = temp_dir("recover-bad");
        let target = dir.join("fluxdl.exe");
        std::fs::write(&target, b"OLD").unwrap();
        std::fs::write(backup_path(&target), b"OLD").unwrap();
        std::fs::write(staged_path(&target), b"HALF-DOWNLOAD").unwrap();
        // 期望的是新版本哈希，但主文件还是旧的 → 判定替换没生效
        write_state(
            &dir,
            &SwapState {
                component: "app".into(),
                from_version: "0.1.0".into(),
                to_version: "0.2.0".into(),
                target: target.to_string_lossy().to_string(),
                backup: backup_path(&target).to_string_lossy().to_string(),
                staged: staged_path(&target).to_string_lossy().to_string(),
                expect_sha256: sha256_hex(b"NEW"),
                started_at: now_ms(),
            },
        )
        .unwrap();

        let result = recover(&dir, &target);
        assert!(matches!(result, Recovery::RolledBack(_)), "应判定为回滚：{result:?}");
        assert_eq!(std::fs::read(&target).unwrap(), b"OLD");
        assert!(read_state(&dir).is_none(), "状态文件要清掉，避免反复回滚");
        assert!(!staged_path(&target).exists(), "暂存文件要清理");
    }

    #[test]
    fn recover_commits_when_binary_matches_expected_hash() {
        let dir = temp_dir("recover-ok");
        let target = dir.join("fluxdl.exe");
        std::fs::write(&target, b"NEW").unwrap();
        std::fs::write(backup_path(&target), b"OLD").unwrap();
        write_state(
            &dir,
            &SwapState {
                component: "app".into(),
                from_version: "0.1.0".into(),
                to_version: "0.2.0".into(),
                target: target.to_string_lossy().to_string(),
                backup: backup_path(&target).to_string_lossy().to_string(),
                staged: staged_path(&target).to_string_lossy().to_string(),
                expect_sha256: sha256_hex(b"NEW"),
                started_at: now_ms(),
            },
        )
        .unwrap();

        assert_eq!(recover(&dir, &target), Recovery::Committed);
        assert!(!backup_path(&target).exists(), "成功提交后备份应清掉");
        assert_eq!(std::fs::read(&target).unwrap(), b"NEW");
    }

    #[test]
    fn recover_restores_when_target_missing() {
        let dir = temp_dir("recover-missing");
        let target = dir.join("fluxdl.exe");
        // 主文件不在（替换到一半断电），只剩备份
        std::fs::write(backup_path(&target), b"OLD").unwrap();
        write_state(
            &dir,
            &SwapState {
                component: "app".into(),
                to_version: "0.2.0".into(),
                expect_sha256: sha256_hex(b"NEW"),
                ..Default::default()
            },
        )
        .unwrap();

        assert!(matches!(recover(&dir, &target), Recovery::RolledBack(_)));
        assert_eq!(std::fs::read(&target).unwrap(), b"OLD");
    }

    #[test]
    fn apply_script_contains_backup_and_fallback_restore() {
        let script = apply_script(Path::new(r"C:\Apps\FluxDL\fluxdl.exe"), &[]);
        assert!(
            script.contains(r#"move /y "C:\Apps\FluxDL\fluxdl.exe" "C:\Apps\FluxDL\fluxdl.exe.bak""#),
            "脚本缺少备份步骤：{script:?}"
        );
        assert!(script.contains(r#"move /y "C:\Apps\FluxDL\fluxdl.exe.new" "C:\Apps\FluxDL\fluxdl.exe""#));
        // 替换失败必须把备份还原，否则用户机器上没有可执行文件
        assert!(script.contains("if not exist"));
        assert!(script.contains(r#"start "" "C:\Apps\FluxDL\fluxdl.exe""#));
        // 必须用绝对路径，不能靠工作目录
        assert!(!script.contains("cd /d"), "不应依赖 cd，工作目录不可信");
    }

    #[test]
    fn tool_state_keeps_previous_for_rollback() {
        let mut state = ToolState::default();
        state.activate("yt-dlp", "2025.10.01");
        state.activate("yt-dlp", "2025.11.01");
        let slot = state.slot("yt-dlp");
        assert_eq!(slot.active.as_deref(), Some("2025.11.01"));
        assert_eq!(slot.previous.as_deref(), Some("2025.10.01"));
        assert_eq!(slot.installed.len(), 2);

        // 重复激活同一版本不应覆盖 previous
        state.activate("yt-dlp", "2025.11.01");
        assert_eq!(state.slot("yt-dlp").previous.as_deref(), Some("2025.10.01"));
    }

    #[test]
    fn github_release_json_parsing() {
        let raw = r#"[
            {"tag_name": "2025.11.01", "assets": [
                {"name": "yt-dlp.exe", "browser_download_url": "https://x/1/yt-dlp.exe"},
                {"name": "yt-dlp.tar.gz", "browser_download_url": "https://x/1/yt-dlp.tar.gz"}
            ]},
            {"tag_name": "2025.10.31", "assets": [
                {"name": "yt-dlp.exe", "browser_download_url": "https://x/2/yt-dlp.exe"}
            ]},
            {"tag_name": "2025.10.30", "assets": []}
        ]"#;
        let list = parse_github_releases(raw, "yt-dlp.exe");
        assert_eq!(list.len(), 2, "没有目标资产的那条要跳过");
        assert_eq!(list[0].0, "2025.11.01");
        assert_eq!(list[1].1, "https://x/2/yt-dlp.exe");
        // 非法 JSON 不 panic
        assert!(parse_github_releases("not json", "yt-dlp.exe").is_empty());
    }

    #[test]
    fn ffmpeg_versions_parsed_from_btbn_json() {
        let raw = r#"{"tag_name":"latest","assets":[
            {"name":"ffmpeg-master-latest-win64-gpl-shared.zip","browser_download_url":"https://x/master.zip","size":80000000},
            {"name":"ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip","browser_download_url":"https://x/9.0-gpl.zip","size":82000000},
            {"name":"ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip","browser_download_url":"https://x/9.0.zip","size":73000000},
            {"name":"ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip","browser_download_url":"https://x/8.1.zip","size":76000000},
            {"name":"ffmpeg-n9.0-latest-win64-lgpl.zip","browser_download_url":"https://x/9.0-full.zip","size":186000000}
        ]}"#;
        let list = parse_ffmpeg_versions(raw);
        assert_eq!(list.len(), 2, "只保留 lgpl-shared 变体");
        assert_eq!(list[0].0, "9.0", "新版本排前面");
        assert_eq!(list[1].0, "8.1");
        assert_eq!(list[0].2, Some(73_000_000));
    }

    #[test]
    fn state_roundtrip_through_disk() {
        let dir = temp_dir("state");
        let state = SwapState {
            component: "app".into(),
            to_version: "0.2.0".into(),
            expect_sha256: "abc".into(),
            ..Default::default()
        };
        write_state(&dir, &state).unwrap();
        let back = read_state(&dir).unwrap();
        assert_eq!(back.to_version, "0.2.0");
        clear_state(&dir);
        assert!(read_state(&dir).is_none());
    }

    #[test]
    fn file_hash_is_streamed_and_stable() {
        let dir = temp_dir("hash");
        let file = dir.join("big.bin");
        let mut f = std::fs::File::create(&file).unwrap();
        // 跨过 64KB 缓冲区边界，确认流式累加正确
        for _ in 0..40 {
            f.write_all(&[7u8; 4096]).unwrap();
        }
        f.flush().unwrap();
        let streamed = file_sha256(&file).unwrap();
        let expected = sha256_hex(&vec![7u8; 40 * 4096]);
        assert_eq!(streamed, expected);
    }
}
