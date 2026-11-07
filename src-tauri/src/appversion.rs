//! 主程序版本库：多版本共存、一键更新、一键回退。
//!
//! 设计取舍
//! --------
//! 不做独立启动器（launcher），只有一个 `fluxdl.exe`。所有"换版本"都归结为同一件事：
//!
//! ```text
//! app-versions\<版本>\fluxdl.exe  ──copy──>  <当前 exe>.new
//!                                              │ SHA-256 校验
//!                                              ▼
//!                       脚本：等旧进程释放文件 → 备份 .bak → 替换 → 拉起新进程
//! ```
//!
//! Windows 会锁住正在运行的 exe，所以替换必须发生在**本进程退出之后**，
//! 由一段独立的 `.cmd` 完成。这也是为什么"点一下更新"之后窗口会先关闭再自己打开。
//!
//! 目录布局
//! --------
//! ```text
//! 安装版：%LOCALAPPDATA%\com.fluxdl.desktop\app-versions\<版本>\fluxdl.exe
//! 便携版：<解压目录>\app-versions\<版本>\fluxdl.exe
//! 状态：  app-versions\..\app-version-state.json
//! ```
//!
//! 崩溃自动回退
//! ------------
//! 没有看护进程，改用"启动自检"：本进程启动时若发现自己就是待应用的新版本，
//! 先把 `attempts` 加一；等 UI 真正起来（setup 走完）才把 `attempts` 清零并把
//! `active` 指向自己。若启动阶段就崩了（缺 dll、配置损坏、setup panic），
//! 计数会一直累加，到 2 次就自动回退到上一版本。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fluxdl_engine::update;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 版本库里的可执行文件名。所有版本都叫这个，靠父目录区分版本。
const EXE_NAME: &str = "fluxdl.exe";
/// 便携版标记文件：存在则版本库跟随解压目录，删目录即卸载。
const PORTABLE_FLAG: &str = "portable.flag";
/// 连续启动失败多少次后自动回退。
pub const MAX_BOOT_ATTEMPTS: u32 = 2;
/// 默认保留的版本数（当前 + 2 个回退位）。
pub const KEEP_VERSIONS: usize = 3;

const STATE_FILE: &str = "app-version-state.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    /// 当前确认可用的版本（新版本启动成功后才会改写）。
    pub active: Option<String>,
    /// 上一版本，供"一键回退"与界面展示。
    pub previous: Option<String>,
    /// 已下载、等待在下次启动时生效的版本。
    pub pending: Option<String>,
    /// 待应用版本的连续启动失败次数。
    pub attempts: u32,
    /// 上一次自动回退"从哪个版本退下来"的，用于避免来回弹跳。
    pub rolled_back_from: Option<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn state_file(dir: &Path) -> PathBuf {
    dir.join(STATE_FILE)
}

pub fn read_state(dir: &Path) -> State {
    std::fs::read_to_string(state_file(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn write_state(dir: &Path, state: &State) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建版本目录失败：{e}"))?;
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{STATE_FILE}.tmp"));
    std::fs::write(&tmp, raw).map_err(|e| format!("写入版本状态失败：{e}"))?;
    std::fs::rename(&tmp, state_file(dir)).map_err(|e| format!("提交版本状态失败：{e}"))
}

/// 便携版根目录：exe 同级存在 `portable.flag` 时返回该目录。
fn portable_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    dir.join(PORTABLE_FLAG).is_file().then_some(dir)
}

/// 版本库根目录。
///
/// 便携版放解压目录（卸载=删文件夹），安装版放数据目录（`$LOCALAPPDATA`，
/// 用户级可写，不需要管理员权限）。
pub fn versions_root(app: &AppHandle) -> PathBuf {
    if let Some(root) = portable_root() {
        return root.join("app-versions");
    }
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("app-versions")
}

/// 当前正在运行的 exe —— 所有替换的目标。
pub fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("定位当前程序失败：{e}"))
}

fn version_exe(dir: &Path, version: &str) -> PathBuf {
    dir.join(version).join(EXE_NAME)
}

/// 语义化版本比较键：(数字段, 是否预发布)。
fn version_key(version: &str) -> (Vec<u64>, bool) {
    let (core, pre) = match version.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (version, None),
    };
    (
        core.split('.')
            .map(|seg| seg.trim().parse::<u64>().unwrap_or(0))
            .collect(),
        pre.is_some(),
    )
}

pub fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let (na, pa) = version_key(a);
    let (nb, pb) = version_key(b);
    for i in 0..na.len().max(nb.len()) {
        let x = na.get(i).copied().unwrap_or(0);
        let y = nb.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    match (pa, pb) {
        // 同号预发布低于正式版
        (false, true) => std::cmp::Ordering::Greater,
        (true, false) => std::cmp::Ordering::Less,
        _ => std::cmp::Ordering::Equal,
    }
}

/// 扫描已安装版本，降序。兼容旧的 `FluxDL.App-<ver>.exe` 布局。
pub fn scan_versions(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    // 布局固定为 <版本>\fluxdl.exe。有目录没 exe 的视为破损残留，
    // 不进列表 —— 否则用户点过去才发现"版本不存在"。
    let mut out: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let usable = path.is_dir()
                && path.join(EXE_NAME).is_file()
                && !name.is_empty()
                && !name.starts_with('.');
            usable.then_some(name)
        })
        .collect();
    out.sort_by(|a, b| cmp_versions(b, a));
    out.dedup();
    out
}

fn version_size(dir: &Path, version: &str) -> u64 {
    std::fs::metadata(version_exe(dir, version))
        .map(|m| m.len())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersionItem {
    pub version: String,
    pub active: bool,
    pub previous: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersionList {
    pub active: String,
    pub previous: Option<String>,
    pub installed: Vec<AppVersionItem>,
    pub versions_dir: String,
    /// 是否允许切换：目标目录不可写时为 false。
    pub managed: bool,
    pub keep: usize,
    pub warning: Option<String>,
}

#[tauri::command]
pub fn app_version_list(app: AppHandle) -> AppVersionList {
    let dir = versions_root(&app);
    let state = read_state(&dir);
    let current = app.package_info().version.to_string();
    let target = current_exe().ok();

    let mut items: Vec<AppVersionItem> = scan_versions(&dir)
        .into_iter()
        .map(|version| AppVersionItem {
            active: version == current || state.active.as_deref() == Some(version.as_str()),
            previous: state.previous.as_deref() == Some(version.as_str()),
            size: version_size(&dir, &version),
            version,
        })
        .collect();

    // 当前在跑的版本可能不在版本库里（例如用户直接双击安装包里的 exe，
    // 或者从旧版本升级上来）。补进去，避免"显示 0.3.0 但列表里没有"。
    if !items.iter().any(|i| i.version == current) {
        let size = target
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0);
        items.insert(
            0,
            AppVersionItem {
                version: current.clone(),
                active: true,
                previous: false,
                size,
            },
        );
    }

    let writable = target
        .as_ref()
        .and_then(|p| p.parent())
        .map(dir_writable)
        .unwrap_or(false);

    AppVersionList {
        active: current,
        previous: state.previous,
        installed: items,
        versions_dir: dir.to_string_lossy().to_string(),
        managed: writable,
        keep: KEEP_VERSIONS,
        warning: (!writable).then(|| {
            "当前程序所在目录不可写，无法原地更新。请把程序放到有写权限的目录，或下载完整安装包覆盖安装。"
                .to_string()
        }),
    }
}

// ---------------------------------------------------------------------------
// 更新 / 回退：把版本库里的某个 exe 换成当前在跑的 exe
// ---------------------------------------------------------------------------

/// 目录是否可写（真写一个临时文件探测，比看权限位可靠）。
pub fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".fluxdl-write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"x") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 把下载好的新版本存进版本库，并记为"待应用"。
pub fn install_version_file(
    app: &AppHandle,
    staged: &Path,
    version: &str,
) -> Result<PathBuf, String> {
    let dir = versions_root(app);
    let slot = version_exe(&dir, version);
    if let Some(parent) = slot.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建版本目录失败：{e}"))?;
    }
    // 同盘 rename 原子；跨盘（暂存放在临时目录）退化为一拷贝二删。
    if std::fs::rename(staged, &slot).is_err() {
        std::fs::copy(staged, &slot).map_err(|e| format!("写入版本文件失败：{e}"))?;
        let _ = std::fs::remove_file(staged);
    }
    let mut state = read_state(&dir);
    state.pending = Some(version.to_string());
    state.attempts = 0;
    write_state(&dir, &state)?;
    Ok(slot)
}

/// 把版本库里的 `version` 应用到当前位置，然后退出，由脚本拉起新进程。
///
/// 返回 Ok 表示脚本已生成并启动，调用方应当立刻 `app.exit(0)`。
pub fn apply_from_library(app: &AppHandle, version: &str) -> Result<String, String> {
    let dir = versions_root(app);
    let source = version_exe(&dir, version);
    if !source.is_file() {
        return Err(format!("版本 {version} 不在本地版本库中"));
    }
    let target = current_exe()?;
    let (staged, sha) = stage_swap(&source, &target)?;

    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| dir.clone());
    update::write_state(
        &data_dir,
        &update::SwapState {
            component: "app".into(),
            from_version: app.package_info().version.to_string(),
            to_version: version.to_string(),
            target: target.to_string_lossy().to_string(),
            backup: update::backup_path(&target).to_string_lossy().to_string(),
            staged: staged.to_string_lossy().to_string(),
            expect_sha256: sha,
            started_at: update::now_ms(),
        },
    )?;

    // 记 pending：下次启动时 boot_guard 靠它判断"我是不是刚被换上来的"。
    let mut state = read_state(&dir);
    if version != app.package_info().version.to_string() {
        // 手动回退时把当前版本记为 previous，界面能显示"上一版本"。
        // 自动回退会写入 rolled_back_from，避免两版之间来回弹跳。
        if state.rolled_back_from.is_none() {
            state.previous = Some(app.package_info().version.to_string());
        }
    }
    state.pending = Some(version.to_string());
    state.attempts = 0;
    write_state(&dir, &state)?;

    launch_swap(&target, &staged, &dir)?;
    Ok(format!("正在切换到 {version}，程序将自动重启"))
}

/// 把版本库里的 exe 复制成 `<目标>.new`，返回（暂存路径, sha256）。
///
/// 抽成不依赖 AppHandle 的纯文件操作，方便单测覆盖"目录不可写 / 空间不足 /
/// 源文件缺失"这些真实会遇到的失败，而不是等到用户点了更新才发现。
fn stage_swap(source: &Path, target: &Path) -> Result<(PathBuf, String), String> {
    if !source.is_file() {
        return Err(format!("版本库中没有 {}", source.display()));
    }
    let parent = target
        .parent()
        .ok_or_else(|| "无法定位程序所在目录".to_string())?;
    if !dir_writable(parent) {
        return Err("程序所在目录不可写，无法原地更新。请下载完整安装包覆盖安装。".into());
    }

    // 空间预检：要同时容纳旧文件备份 + 新文件。
    let need = std::fs::metadata(source).map(|m| m.len()).unwrap_or(0) * 2;
    if let Some(free) = free_space(parent) {
        if free < need {
            return Err(format!(
                "磁盘空间不足：需要约 {}，当前可用 {}",
                human(need),
                human(free)
            ));
        }
    }

    // 先落到同目录的 .new：同卷 rename 才能原子替换。
    let staged = update::staged_path(target);
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(source, &staged).map_err(|e| format!("准备新版本失败：{e}"))?;
    let sha = update::file_sha256(&staged).ok_or_else(|| "读取新版本校验值失败".to_string())?;
    Ok((staged, sha))
}

/// 生成并启动延迟替换脚本，然后立刻返回。调用方紧接着 `app.exit(0)`。
/// Unix 允许替换正在运行的文件，直接换，不需要延迟脚本（也便于本地调试）。
#[cfg(not(windows))]
fn launch_swap(target: &Path, staged: &Path, versions_dir: &Path) -> Result<(), String> {
    let _ = versions_dir;
    std::fs::rename(staged, target).map_err(|e| format!("替换文件失败：{e}"))
}

/// Windows：生成延迟替换脚本并启动，脚本会等本进程退出后再动文件。
///
/// 脚本正文是纯 ASCII，路径一律走环境变量 —— `.cmd` 按系统代码页解析，
/// 中文用户名 / 中文安装路径内嵌进脚本会乱码（详见 `update::apply_script_wait`）。
#[cfg(windows)]
fn launch_swap(target: &Path, staged: &Path, versions_dir: &Path) -> Result<(), String> {
    let script = update::apply_script_wait();
    let path = versions_dir.join(format!("swap-{}.cmd", now_ms()));
    std::fs::create_dir_all(versions_dir).map_err(|e| format!("创建脚本目录失败：{e}"))?;
    std::fs::write(&path, script).map_err(|e| format!("写入替换脚本失败：{e}"))?;

    let mut cmd = std::process::Command::new("cmd");
    cmd.arg("/c")
        .arg(&path)
        .env("FLUXDL_TARGET", target)
        .env("FLUXDL_SOURCE", staged)
        .env("FLUXDL_ARGS", "");

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn().map_err(|e| format!("启动替换脚本失败：{e}"))?;
    Ok(())
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut idx = 0;
    while value >= 1024.0 && idx < UNITS.len() - 1 {
        value /= 1024.0;
        idx += 1;
    }
    format!("{value:.1} {}", UNITS[idx])
}

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    // 不引入额外依赖：用 `fsutil` 太重，这里直接用可用空间探测失败即跳过预检。
    let _ = dir;
    None
}

#[cfg(not(windows))]
fn free_space(dir: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};
    #[repr(C)]
    struct StatVfs {
        f_bsize: u64,
        f_frsize: u64,
        f_blocks: u64,
        f_bfree: u64,
        f_bavail: u64,
        f_files: u64,
        f_ffree: u64,
        f_favail: u64,
        f_fsid: u64,
        f_flag: u64,
        f_namemax: u64,
        spare: [c_int; 4],
    }
    extern "C" {
        fn statvfs(path: *const c_char, buf: *mut StatVfs) -> c_int;
    }
    let c = CString::new(dir.to_string_lossy().as_bytes()).ok()?;
    let mut buf = std::mem::MaybeUninit::<StatVfs>::zeroed();
    // SAFETY: `buf` 是有效的可写内存，`c` 是以 NUL 结尾的路径。
    let rc = unsafe { statvfs(c.as_ptr(), buf.as_mut_ptr()) };
    if rc != 0 {
        return None;
    }
    let v = unsafe { buf.assume_init() };
    Some(v.f_bavail.saturating_mul(v.f_frsize))
}

// ---------------------------------------------------------------------------
// 启动自检：判定"这次启动是否成功"，失败到阈值就自动回退
// ---------------------------------------------------------------------------

/// `decide_boot` 的判定结果。抽成纯函数，方便单测覆盖全部路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootAction {
    /// 普通启动，没有待应用的版本。
    Proceed,
    /// 升级后的首次启动：计数已 +1，继续启动。
    Counting,
    /// 替换脚本没跑成（用户取消、断电），当前还是旧版本，清掉 pending 即可。
    ApplyFailed,
    /// 连续失败达阈值，回退到指定版本。
    Rollback(String),
    /// 失败达阈值但无可回退版本（或回退会造成来回弹跳），放弃自动处理。
    GiveUp(String),
}

/// 纯判定逻辑：不碰磁盘，只根据状态和"我是哪个版本"给结论。
pub fn decide_boot(state: &State, running: &str, max_attempts: u32) -> BootAction {
    let Some(pending) = state.pending.as_deref() else {
        return BootAction::Proceed;
    };
    if pending != running {
        // 状态说要切到新版本，但跑起来的还是旧版本 → 替换根本没发生。
        return BootAction::ApplyFailed;
    }
    if state.attempts + 1 < max_attempts {
        return BootAction::Counting;
    }
    match state.previous.as_deref() {
        Some(prev)
            if prev != pending
                && prev != state.rolled_back_from.as_deref().unwrap_or_default()
                && !prev.is_empty() =>
        {
            BootAction::Rollback(prev.to_string())
        }
        Some(prev) => BootAction::GiveUp(format!(
            "新版本 {pending} 连续 {max_attempts} 次启动失败，且上一版本 {prev} 也已被判定不可用"
        )),
        None => BootAction::GiveUp(format!(
            "新版本 {pending} 连续 {max_attempts} 次启动失败，但没有可回退的版本"
        )),
    }
}

/// 最近一次下载完成、等待应用的版本。
pub fn pending_version(app: &AppHandle) -> Option<String> {
    read_state(&versions_root(app)).pending
}

/// setup 的第一行调用。可能直接触发回退并让本进程退出。
pub fn boot_guard(app: &AppHandle) -> Option<String> {
    let dir = versions_root(app);
    let mut state = read_state(&dir);
    let running = app.package_info().version.to_string();

    match decide_boot(&state, &running, MAX_BOOT_ATTEMPTS) {
        BootAction::Proceed => None,
        BootAction::Counting => {
            state.attempts += 1;
            let _ = write_state(&dir, &state);
            None
        }
        BootAction::ApplyFailed => {
            // 替换没成功：当前跑的仍是旧版本，把它确认为 active 并清掉 pending。
            state.pending = None;
            state.attempts = 0;
            state.active = Some(running);
            let _ = write_state(&dir, &state);
            Some("上次更新没有完成（替换脚本未生效），已保留原版本，请重试更新。".to_string())
        }
        BootAction::Rollback(prev) => {
            let source = version_exe(&dir, &prev);
            if !source.is_file() {
                state.pending = None;
                state.attempts = 0;
                state.active = Some(running);
                let _ = write_state(&dir, &state);
                return Some(format!(
                    "新版本启动失败，但回退目标 {prev} 已不在本地版本库中。请手动安装可用版本。"
                ));
            }
            let target = match current_exe() {
                Ok(p) => p,
                Err(e) => return Some(format!("自动回退失败：{e}")),
            };
            let staged = update::staged_path(&target);
            let _ = std::fs::remove_file(&staged);
            if let Err(e) = std::fs::copy(&source, &staged) {
                return Some(format!("自动回退准备失败：{e}"));
            }
            let mut next = state.clone();
            next.pending = Some(prev.clone());
            next.attempts = 0;
            next.active = Some(prev.clone());
            next.previous = Some(running.clone());
            next.rolled_back_from = Some(running.clone());
            let _ = write_state(&dir, &next);
            match launch_swap(&target, &staged, &dir) {
                Ok(()) => {
                    // 脚本会等本进程退出后再替换，所以这里立刻退。
                    app.exit(0);
                    Some(format!("新版本启动失败，正在回退到 {prev}"))
                }
                Err(e) => Some(format!("自动回退失败：{e}，请手动安装可用版本")),
            }
        }
        BootAction::GiveUp(reason) => {
            state.pending = None;
            state.attempts = 0;
            state.active = Some(running);
            let _ = write_state(&dir, &state);
            Some(format!("{reason}。请到设置页下载完整安装包。"))
        }
    }
}

/// setup 最后一步调用：UI 真的起来了，把这次启动确认为成功。
pub fn mark_healthy(app: &AppHandle) {
    let dir = versions_root(app);
    let mut state = read_state(&dir);
    let running = app.package_info().version.to_string();
    let changed = state.active.as_deref() != Some(running.as_str())
        || state.pending.is_some()
        || state.attempts != 0;
    if !changed {
        return;
    }
    if state.active.as_deref() != Some(running.as_str()) {
        state.previous = state.active.clone().filter(|v| v != &running);
    }
    state.active = Some(running);
    state.pending = None;
    state.attempts = 0;
    state.rolled_back_from = None;
    let _ = write_state(&dir, &state);
}

#[tauri::command]
pub fn activate_app_version(app: AppHandle, version: String) -> Result<String, String> {
    let current = app.package_info().version.to_string();
    if version == current {
        return Ok(format!("已经在使用 {version}"));
    }
    let dir = versions_root(&app);
    if !version_exe(&dir, &version).is_file() {
        return Err(format!("版本 {version} 不在本地版本库中"));
    }
    apply_from_library(&app, &version)
}

#[tauri::command]
pub fn delete_app_version(app: AppHandle, version: String) -> Result<String, String> {
    let dir = versions_root(&app);
    let current = app.package_info().version.to_string();
    if version == current {
        return Err("不能删除正在使用的版本".into());
    }
    let all = scan_versions(&dir);
    if all.len() <= 2 {
        return Err("至少保留两个版本，否则出问题没有可回退的余地".into());
    }
    let slot = dir.join(&version);
    if slot.is_dir() {
        std::fs::remove_dir_all(&slot).map_err(|e| format!("删除失败（可能仍被占用）：{e}"))?;
    } else {
        std::fs::remove_file(version_exe(&dir, &version))
            .map_err(|e| format!("删除失败（可能仍被占用）：{e}"))?;
    }
    let mut state = read_state(&dir);
    if state.previous.as_deref() == Some(version.as_str()) {
        state.previous = None;
        let _ = write_state(&dir, &state);
    }
    Ok(format!("已删除 {version}"))
}

/// 只保留最近 N 个版本，当前使用的与上一版本必留。
pub fn prune_versions(app: &AppHandle, keep: usize) -> Vec<String> {
    let dir = versions_root(app);
    let state = read_state(&dir);
    let current = app.package_info().version.to_string();
    let all = scan_versions(&dir);
    let keep = keep.max(2);

    let mut kept: Vec<String> = Vec::new();
    if all.iter().any(|v| *v == current) {
        kept.push(current.clone());
    }
    if let Some(prev) = state.previous.as_deref() {
        if all.iter().any(|v| v == prev) && !kept.iter().any(|k| k == prev) {
            kept.push(prev.to_string());
        }
    }
    for version in all.iter() {
        if kept.len() >= keep {
            break;
        }
        if !kept.iter().any(|k| k == version) {
            kept.push(version.clone());
        }
    }

    let mut removed = Vec::new();
    for version in all {
        if kept.iter().any(|k| *k == version) {
            continue;
        }
        let slot = dir.join(&version);
        let ok = if slot.is_dir() {
            std::fs::remove_dir_all(&slot).is_ok()
        } else {
            std::fs::remove_file(version_exe(&dir, &version)).is_ok()
        };
        if ok {
            removed.push(version);
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(pending: Option<&str>, previous: Option<&str>, attempts: u32) -> State {
        State {
            active: Some("0.2.0".into()),
            previous: previous.map(str::to_string),
            pending: pending.map(str::to_string),
            attempts,
            rolled_back_from: None,
        }
    }

    #[test]
    fn semver_ordering() {
        use std::cmp::Ordering::*;
        assert_eq!(cmp_versions("0.3.0", "0.2.9"), Greater);
        assert_eq!(cmp_versions("0.10.0", "0.9.9"), Greater);
        assert_eq!(cmp_versions("0.3.0-beta", "0.3.0"), Less);
        assert_eq!(cmp_versions("1.0.0", "1.0"), Equal);
    }

    #[test]
    fn scans_only_usable_version_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for version in ["0.3.0", "0.2.0"] {
            std::fs::create_dir_all(root.join(version)).unwrap();
            std::fs::write(root.join(version).join(EXE_NAME), b"x").unwrap();
        }
        // 有目录没 exe：破损残留，不进列表
        std::fs::create_dir_all(root.join("0.0.9")).unwrap();
        // 状态文件不是目录，不该被当成版本
        std::fs::write(root.join(STATE_FILE), b"{}").unwrap();

        assert_eq!(scan_versions(root), vec!["0.3.0", "0.2.0"]);
    }

    #[test]
    fn state_roundtrip_keeps_attempts() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = state(Some("0.3.0"), Some("0.2.0"), 1);
        s.rolled_back_from = Some("0.3.0".into());
        write_state(dir.path(), &s).unwrap();
        let loaded = read_state(dir.path());
        assert_eq!(loaded.pending.as_deref(), Some("0.3.0"));
        assert_eq!(loaded.attempts, 1);
        assert_eq!(loaded.rolled_back_from.as_deref(), Some("0.3.0"));
    }

    #[test]
    fn boot_without_pending_is_normal() {
        assert_eq!(
            decide_boot(&state(None, Some("0.2.0"), 0), "0.3.0", 2),
            BootAction::Proceed
        );
    }

    #[test]
    fn boot_counts_first_failure() {
        // 第一次以新版本启动：计数 +1，还不到阈值
        assert_eq!(
            decide_boot(&state(Some("0.3.0"), Some("0.2.0"), 0), "0.3.0", 2),
            BootAction::Counting
        );
    }

    #[test]
    fn boot_rolls_back_on_second_failure() {
        assert_eq!(
            decide_boot(&state(Some("0.3.0"), Some("0.2.0"), 1), "0.3.0", 2),
            BootAction::Rollback("0.2.0".into())
        );
    }

    #[test]
    fn boot_detects_script_never_ran() {
        // pending 是 0.3.0，但跑起来的是 0.2.0 → 替换没生效
        assert_eq!(
            decide_boot(&state(Some("0.3.0"), Some("0.1.0"), 0), "0.2.0", 2),
            BootAction::ApplyFailed
        );
    }

    #[test]
    fn boot_gives_up_without_previous() {
        match decide_boot(&state(Some("0.3.0"), None, 1), "0.3.0", 2) {
            BootAction::GiveUp(msg) => assert!(msg.contains("没有可回退")),
            other => panic!("意外结果：{other:?}"),
        }
    }

    #[test]
    fn boot_does_not_bounce_between_two_versions() {
        // 刚从 0.3.0 回退到 0.2.0，0.2.0 也起不来 → 不能再弹回 0.3.0
        let mut s = state(Some("0.2.0"), Some("0.3.0"), 1);
        s.rolled_back_from = Some("0.3.0".into());
        match decide_boot(&s, "0.2.0", 2) {
            BootAction::GiveUp(msg) => assert!(msg.contains("也已被判定不可用")),
            other => panic!("意外结果：{other:?}"),
        }
    }

    #[test]
    fn stage_swap_copies_and_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("lib/fluxdl.exe");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"NEWBUILD").unwrap();
        let target = dir.path().join("app/fluxdl.exe");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"OLD").unwrap();

        let (staged, sha) = stage_swap(&source, &target).unwrap();
        assert_eq!(staged, target.with_file_name("fluxdl.exe.new"));
        assert_eq!(std::fs::read(&staged).unwrap(), b"NEWBUILD");
        assert_eq!(sha, update::sha256_hex(b"NEWBUILD"));
        // 准备阶段绝不能碰正在运行的文件
        assert_eq!(std::fs::read(&target).unwrap(), b"OLD");
    }

    #[test]
    fn stage_swap_rejects_missing_source() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("fluxdl.exe");
        std::fs::write(&target, b"OLD").unwrap();
        let err = stage_swap(&dir.path().join("nope.exe"), &target).unwrap_err();
        assert!(err.contains("版本库中没有"), "错误信息应说明源缺失：{err}");
    }

    #[test]
    fn writable_probe_rejects_readonly_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(dir_writable(dir.path()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
            // root 仍可写，这条断言只在非 root 环境有意义
            if unsafe { libc_geteuid() } != 0 {
                assert!(!dir_writable(dir.path()));
            }
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[cfg(unix)]
    extern "C" {
        #[link_name = "geteuid"]
        fn libc_geteuid() -> u32;
    }
}
