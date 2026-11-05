use crate::manager::{Engine, EngineError, TaskEntry};
use crate::types::*;
use crate::util;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::SystemTime;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const PROGRESS_TEMPLATE: &str = "download:FLUXDL|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.filename)s";

/// 逐行读取子进程输出，一直读到 EOF 才关闭读端。
///
/// 不能用 `BufReader::lines()`：它遇到非法 UTF-8 会返回 `Err`，旧实现写成
/// `while let Ok(Some(line))` 会因此提前退出、drop 掉 stdout 读端。Windows
/// 中文系统下 PyInstaller 版 `yt-dlp.exe` 的 stdout 默认走系统 ANSI 代码页
/// （GBK），进度模板里带中文文件名时就会产出非法 UTF-8 字节。管道读端一关，
/// yt-dlp 再写 stdout 拿到 Windows CRT 映射出来的 EINVAL(22)，于是报
/// `Unable to download video: [Errno 22] Invalid argument`，退出时 flush
/// 又抛一次 `Exception ignored while flushing sys.stdout`。
///
/// 改为读原始字节 + lossy 解码：编码问题最多让某一行显示成乱码，不会中断下载。
fn spawn_line_reader<R>(
    reader: R,
    tx: mpsc::UnboundedSender<String>,
    prefix: &'static str,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break, // 真正的 EOF，此时关闭读端才安全
                Ok(_) => {
                    while let Some(&last) = buf.last() {
                        if last == b'\n' || last == b'\r' {
                            buf.pop();
                        } else {
                            break;
                        }
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    let _ = tx.send(format!("{prefix}{line}"));
                }
                Err(_) => break, // 只有真实 IO 错误才停止
            }
        }
    });
}

/// 用完即删的 cookie 临时文件。任务暂停时保留，方便续跑时继续带登录态。
struct CookieFileGuard {
    path: Option<PathBuf>,
}

impl CookieFileGuard {
    fn new(path: Option<PathBuf>) -> Self {
        Self { path }
    }

    fn keep(&mut self) {
        self.path = None;
    }
}

impl Drop for CookieFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// yt-dlp 的 bot 校验报错，用于决定是否追加本地化指引。
fn needs_bot_hint(errors: &[String]) -> bool {
    errors.iter().any(|e| {
        e.contains("Sign in to confirm you're not a bot")
            || e.contains("--cookies-from-browser")
    })
}

/// 默认格式选择：优先「最佳视频流 + 最佳音频流」合并，退到整体 best。
/// 保持原行为不变，只有降级重试时才放宽。
const DEFAULT_FORMAT: &str = "bv*+ba/b";
/// 降级重试用的格式链，最后退到最低清晰度，避免一个都选不中。
const FALLBACK_FORMAT: &str = "bv*+ba/b/worst";
/// 降级重试时换用的 YouTube 客户端：android_vr / web_safari 等不依赖
/// PO Token，是 yt-dlp 应对「Requested format is not available」的常用组合。
/// `--extractor-args` 只对 youtube 提取器生效，B 站等其它站点不受影响。
const FALLBACK_CLIENTS: &str = "android_vr,web_safari,tv,ios,mweb";
const FORMAT_HINT: &str = "（YouTube 未返回可下载清晰度：多为 PO Token / 客户端限制，或会员、年龄、地区限制。请先在 Chrome 确认该视频能正常播放且已登录，再点「重试下载」；换一个普通公开视频可判断是单个视频受限还是整体风控）";
const RELOAD_HINT: &str = "（YouTube 要求刷新页面：多为内置 yt-dlp 版本过旧、解不开前端挑战所致。FluxDL 已尝试自动更新 yt-dlp 并重试；若仍失败，多为 IP / 代理被限流或登录态失效，请换新网络或重新登录 YouTube 后再试）";

/// 判断这次失败是不是「没拿到可用格式」，决定是否值得降级重试。
fn needs_format_retry(errors: &[String]) -> bool {
    errors.iter().any(|e| {
        e.contains("Requested format is not available")
            || e.contains("No video formats available")
            || e.contains("--list-formats")
    })
}

/// YouTube 近期反爬报错「The page needs to be reloaded」：通常是随包 yt-dlp 太旧、
/// 跟不上 YouTube 前端变化所致。根因不在命令写法，而是工具版本，故走「自动更新
/// yt-dlp 后重试」这条路，而不是换客户端。
fn needs_reload_retry(errors: &[String]) -> bool {
    errors.iter().any(|e| {
        e.contains("The page needs to be reloaded")
            || e.contains("Please sign in to confirm you're not a bot")
    })
}

pub async fn run(
    engine: &Arc<Engine>,
    entry: &Arc<TaskEntry>,
    token: CancellationToken,
) -> Result<(), EngineError> {
    // cookie 只在本次进程内有效；文件不存在（例如重启后）就当没有登录态，
    // 绝不让失效路径阻塞正常下载。
    let cookie_path = entry
        .options
        .cookies_file
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.is_file());
    let mut cookie_guard = CookieFileGuard::new(cookie_path.clone());
    // 降级重试可能跑两轮 yt-dlp，凭证文件必须跨两轮存活：guard 提到外层，
    // 只有真正暂停（取消）才保留，成功或失败都按「用完即删」处理。
    let cancelled = token.clone();
    let result = run_inner(engine, entry, &token, cookie_path.as_deref(), false, false).await;
    if cancelled.is_cancelled() {
        cookie_guard.keep();
    }
    result
}

async fn run_inner(
    engine: &Arc<Engine>,
    entry: &Arc<TaskEntry>,
    token: &CancellationToken,
    cookie_path: Option<&Path>,
    fallback: bool,
    reload_retry: bool,
) -> Result<(), EngineError> {
    let options = engine.options();
    let (save_dir, placeholder) = {
        let view = entry.view.lock().await;
        (
            PathBuf::from(&view.save_path)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(&options.save_dir)),
            view.filename.clone(),
        )
    };
    util::ensure_dir(&save_dir)?;
    // 先拍一份目录快照：`--print after_move` 给出的路径若因编码 / 版本差异
    // 无法解析，仍可靠「本次运行新增或变新的文件」定位 yt-dlp 的真实产物。
    let before = snapshot_files(&save_dir);

    let bin = options.yt_dlp_path.trim();
    let bin = if bin.is_empty() { "yt-dlp" } else { bin };

    let mut cmd = Command::new(bin);
    cmd.arg("--newline")
        .arg("--no-playlist")
        .arg("--quiet")
        .arg("--progress")
        .arg("--no-warnings")
        .arg("--retries")
        .arg("5")
        .arg("--fragment-retries")
        .arg("10")
        .arg("--progress-template")
        .arg(PROGRESS_TEMPLATE)
        .arg("--print")
        .arg("after_move:FLUXDONE|%(filepath)s")
        .arg("-P")
        .arg(&save_dir)
        .arg("-o")
        .arg("%(title).150B [%(id)s].%(ext)s")
        .arg("-f")
        .arg(
            entry.options.format.as_deref().unwrap_or(if fallback {
                FALLBACK_FORMAT
            } else {
                DEFAULT_FORMAT
            }),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Windows 中文系统下 yt-dlp.exe 的 stdout 默认按系统 ANSI 代码页
        // （GBK）编码，而 Rust 端按 UTF-8 解析。强制 Python 侧统一用 UTF-8，
        // 从源头避免进度行 / 文件路径里的中文变成非法 UTF-8 字节。
        // PYTHONUNBUFFERED 让进度在管道下也能逐行实时送达。
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8:replace")
        .env("PYTHONUNBUFFERED", "1")
        .kill_on_drop(true);

    // 降级重试：换一组不依赖 PO Token 的 YouTube 客户端重新拿格式列表。
    // 只在报错为「格式不可用」时走到这里，正常下载路径完全不受影响。
    if fallback {
        cmd.arg("--extractor-args")
            .arg(format!("youtube:player_client={FALLBACK_CLIENTS}"));
    }
    if let Some(ffmpeg) = options.ffmpeg_path.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--ffmpeg-location").arg(ffmpeg.trim());
        cmd.arg("--merge-output-format").arg("mp4");
    }
    if let Some(proxy) = entry.proxy.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--proxy").arg(proxy.trim());
    }
    if let Some(referer) = entry.options.referer.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--referer").arg(referer);
    }
    // 视频站点的登录态：yt-dlp 报 "Sign in to confirm you're not a bot" 时
    // 必须带 cookies.txt，否则连格式列表都拿不到。
    if let Some(path) = cookie_path {
        cmd.arg("--cookies").arg(path);
    }
    cmd.arg(&entry.url);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            EngineError::message(format!(
                "未找到 yt-dlp（{bin}）。请安装 yt-dlp，或在设置中填写完整路径"
            ))
        } else {
            EngineError::message(format!("启动 yt-dlp 失败：{e}"))
        }
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    if let Some(stdout) = stdout {
        spawn_line_reader(stdout, tx.clone(), "");
    }
    if let Some(stderr) = stderr {
        spawn_line_reader(stderr, tx.clone(), "ERR|");
    }
    drop(tx);

    {
        let mut view = entry.view.lock().await;
        view.status = TaskStatus::Downloading;
    }
    engine.emit_task(entry).await;

    let mut final_path: Option<PathBuf> = None;
    let mut errors: Vec<String> = Vec::new();
    let mut last_emit = std::time::Instant::now();

    loop {
        let next = tokio::select! {
            _ = token.cancelled() => {
                let _ = child.kill().await;
                return Err(EngineError::Paused);
            }
            line = rx.recv() => line,
        };
        let Some(line) = next else { break };

        if let Some(rest) = line.strip_prefix("FLUXDL|") {
            let parts: Vec<&str> = rest.splitn(6, '|').collect();
            if parts.len() >= 5 {
                let downloaded = parts[0].parse::<u64>().unwrap_or(0);
                let total = parts[1]
                    .parse::<u64>()
                    .ok()
                    .filter(|v| *v > 0)
                    .or_else(|| parts[2].parse::<u64>().ok())
                    .unwrap_or(0);
                let speed = parts[3].parse::<f64>().unwrap_or(0.0) as u64;
                let eta = parts[4].parse::<f64>().ok().map(|v| v.max(0.0) as u64);
                let file = parts.get(5).map(|s| s.trim()).filter(|s| !s.is_empty());
                entry.downloaded.store(downloaded, Ordering::Relaxed);
                let mut view = entry.view.lock().await;
                view.total_bytes = total;
                view.downloaded_bytes = downloaded;
                view.speed_bps = speed;
                view.eta_seconds = eta;
                if let Some(file) = file {
                    let path = if Path::new(file).is_absolute() {
                        PathBuf::from(file)
                    } else {
                        save_dir.join(file)
                    };
                    if let Some(name) = path.file_name() {
                        view.filename = name.to_string_lossy().to_string();
                    }
                }
                view.mime = Some("video/*".into());
                drop(view);
                if last_emit.elapsed() > std::time::Duration::from_millis(400) {
                    last_emit = std::time::Instant::now();
                    engine.emit_task(entry).await;
                }
            }
        } else if let Some(rest) = line.strip_prefix("FLUXDONE|") {
            let path = PathBuf::from(rest.trim());
            final_path = Some(if path.is_absolute() { path } else { save_dir.join(path) });
        } else if let Some(rest) = line.strip_prefix("ERR|") {
            let rest = rest.trim();
            if rest.is_empty() {
                continue;
            }
            errors.push(rest.to_string());
            if errors.len() > 24 {
                errors.remove(0);
            }
            engine.emit_log(&entry.id, rest);
        }
    }

    let status = child.wait().await?;
    if token.is_cancelled() {
        return Err(EngineError::Paused);
    }
    if !status.success() {
        let tail = errors
            .iter()
            .rev()
            .take(4)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" / ");
        // 第一层：遇到「没拿到可用格式」时，换客户端 + 放宽格式链自动重试一次。
        // Box::pin 打断 async fn 的递归 Future 类型，避免 E0733。
        if !fallback && needs_format_retry(&errors) {
            engine.emit_log(
                &entry.id,
                "未取得可用清晰度，自动换 yt-dlp 客户端并放宽格式后重试一次…",
            );
            return Box::pin(run_inner(engine, entry, token, cookie_path, true, reload_retry)).await;
        }
        // 第二层：遇到 YouTube「页面需重载」（反爬挑战 / 旧版 yt-dlp）时，强制更新
        // 内置 yt-dlp 后重试一次默认路径。这是该报错最常见、也最有效的修复。
        if !reload_retry && needs_reload_retry(&errors) {
            match engine.update_ytdlp(true).await {
                crate::ytdlp::UpdateResult::Updated => {
                    engine.emit_log(&entry.id, "已自动更新 yt-dlp，重新尝试下载…");
                    return Box::pin(run_inner(engine, entry, token, cookie_path, false, true)).await;
                }
                _ => {
                    // 更新失败或已是最新仍报错：再退一步换客户端 + 放宽格式做一次尝试。
                    if !fallback {
                        engine.emit_log(
                            &entry.id,
                            "尝试更换 yt-dlp 客户端与格式链后重试…",
                        );
                        return Box::pin(run_inner(engine, entry, token, cookie_path, true, true))
                            .await;
                    }
                }
            }
        }
        // yt-dlp 的英文报错对中文用户不够可操作，补一句本地化指引。
        const BOT_HINT: &str = "（YouTube 要求登录状态：请先在 Chrome 登录 YouTube，确认扩展「视频站点自动带上登录状态」已开启并重新加载扩展；若仍失败，多为 YouTube 的 PO Token 校验）";
        let hint = if needs_bot_hint(&errors) {
            BOT_HINT
        } else if needs_format_retry(&errors) {
            FORMAT_HINT
        } else if needs_reload_retry(&errors) {
            RELOAD_HINT
        } else {
            ""
        };
        return Err(EngineError::message(if tail.is_empty() {
            format!("yt-dlp 退出码 {:?}{hint}", status.code())
        } else {
            format!("yt-dlp 失败：{tail}{hint}")
        }));
    }

    // FLUXDONE 里的路径在 Windows 中文系统下可能是 GBK 字节，lossy 解码后
    // 会变成乱码路径。此时先用「目录快照差分」找真实产物，再退回文件名匹配。
    let mut resolved = final_path.filter(|p| p.exists());
    if resolved.is_none() {
        resolved = find_new_output(&save_dir, &before)
            .or_else(|| find_output(&save_dir, &placeholder));
    }

    let mut view = entry.view.lock().await;
    if let Some(path) = resolved {
        if let Some(name) = path.file_name() {
            view.filename = name.to_string_lossy().to_string();
        }
        view.save_path = path.to_string_lossy().to_string();
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        view.total_bytes = size.max(view.downloaded_bytes);
        view.downloaded_bytes = view.total_bytes;
        entry.downloaded.store(view.total_bytes, Ordering::Relaxed);
    } else {
        return Err(EngineError::message("下载完成，但未找到输出的视频文件"));
    }
    drop(view);
    Ok(())
}



/// 记录目录里现有文件的大小 / 修改时间，用于下载后做差分。
fn snapshot_files(dir: &Path) -> HashMap<PathBuf, (u64, SystemTime)> {
    let mut out = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if let Ok(meta) = e.metadata() {
                if meta.is_file() {
                    out.insert(
                        e.path(),
                        (meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)),
                    );
                }
            }
        }
    }
    out
}

/// 找出本次运行新增（或被改写）的产物，排除 yt-dlp 的中间文件。
///
/// 这层兜底专门处理「FLUXDONE 路径不可解析」的情况：Windows 中文系统下
/// `--print after_move` 可能吐 GBK 字节，lossy 解码后路径不存在，旧实现会
/// 把一次成功下载误判成「未找到输出的视频文件」。
fn find_new_output(
    dir: &Path,
    before: &HashMap<PathBuf, (u64, SystemTime)>,
) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let path = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        if name.ends_with(".part")
            || name.ends_with(".ytdl")
            || name.ends_with(".fluxdl-part")
            || name.ends_with(".tmp")
        {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let changed = match before.get(&path) {
            None => true,
            Some((size, old_mtime)) => *size != meta.len() || modified > *old_mtime,
        };
        if !changed {
            continue;
        }
        if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, p)| p)
}

fn find_output(dir: &Path, placeholder: &str) -> Option<PathBuf> {
    let stem = Path::new(placeholder)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = entry.metadata().ok()?;
        if !meta.is_file() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        if name.ends_with(".part") || name.ends_with(".ytdl") {
            continue;
        }
        let matches = name.contains(&stem) || stem.is_empty() || stem == "video";
        if !matches {
            continue;
        }
        if let Ok(modified) = meta.modified() {
            if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                best = Some((modified, path));
            }
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::{
        needs_bot_hint, needs_format_retry, needs_reload_retry, find_new_output, snapshot_files,
        spawn_line_reader, CookieFileGuard, DEFAULT_FORMAT, FALLBACK_FORMAT,
        FALLBACK_CLIENTS, FORMAT_HINT,
    };
    use tokio::io::{duplex, AsyncWriteExt};
    use tokio::sync::mpsc;

    async fn collect(bytes: &[u8], prefix: &'static str) -> Vec<String> {
        let (mut writer, reader) = duplex(1024);
        let owned = bytes.to_vec();
        tokio::spawn(async move {
            writer.write_all(&owned).await.unwrap();
            drop(writer); // 关闭写端 => 读端收到 EOF
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        spawn_line_reader(reader, tx, prefix);
        let mut out = Vec::new();
        while let Some(line) = rx.recv().await {
            out.push(line);
        }
        out
    }

    /// 复现 Windows GBK 输出场景：一行里含非法 UTF-8 字节，
    /// 旧实现会在此退出并丢掉后续所有行（ yt-dlp 随即 EINVAL(22) 崩溃）。
    #[tokio::test]
    async fn invalid_utf8_does_not_stop_the_reader() {
        let lines = collect(
            b"download:FLUXDL|1|2|0|0|0|video-\xff\xfe.mp4\nFLUXDONE|/tmp/ok.mp4\n",
            "",
        )
        .await;
        assert_eq!(lines.len(), 2, "非法 UTF-8 之后的行必须继续被读到");
        assert!(lines[0].starts_with("download:FLUXDL|"));
        assert!(lines[1].starts_with("FLUXDONE|"));
    }

    #[tokio::test]
    async fn stderr_lines_keep_prefix_and_empty_lines() {
        let lines = collect(b"ERROR: bad\n\nWARNING: slow\n", "ERR|").await;
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "ERR|ERROR: bad");
        assert_eq!(lines[1], "ERR|");
        assert_eq!(lines[2], "ERR|WARNING: slow");
    }

    #[tokio::test]
    async fn crlf_and_last_line_without_newline() {
        let lines = collect(b"one\r\ntwo", "").await;
        assert_eq!(lines, vec!["one".to_string(), "two".to_string()]);
    }

    /// FLUXDONE 路径是乱码时，靠目录差分仍能找到中文名产物，且忽略 .part 中间文件。
    #[tokio::test]
    async fn directory_diff_finds_output_with_mojibake_path() {
        let dir = tempfile::tempdir().unwrap();
        let before = snapshot_files(dir.path());
        std::fs::write(dir.path().join("中文标题 [abc].mp4"), b"video-data").unwrap();
        std::fs::write(dir.path().join("正在下载.part"), b"partial").unwrap();
        let found = find_new_output(dir.path(), &before).unwrap();
        assert_eq!(found.file_name().unwrap(), "中文标题 [abc].mp4");
    }

    #[tokio::test]
    async fn directory_diff_ignores_untouched_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("older.mp4"), b"old").unwrap();
        let before = snapshot_files(dir.path());
        assert!(find_new_output(dir.path(), &before).is_none());
    }

    #[test]
    fn cookie_file_is_deleted_when_task_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cookies.txt");
        std::fs::write(&path, b"credential").unwrap();
        {
            let _guard = CookieFileGuard::new(Some(path.clone()));
            assert!(path.exists());
        }
        assert!(!path.exists(), "任务结束后凭证文件必须删掉");
    }

    #[test]
    fn cookie_file_is_kept_when_task_is_paused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cookies.txt");
        std::fs::write(&path, b"credential").unwrap();
        {
            let mut guard = CookieFileGuard::new(Some(path.clone()));
            guard.keep();
        }
        assert!(path.exists(), "暂停时保留 cookie 文件以便续跑");
    }

    #[test]
    fn bot_hint_only_for_youtube_challenge() {
        assert!(needs_bot_hint(&[
            "ERROR: [youtube] abc: Sign in to confirm you're not a bot".into()
        ]));
        assert!(needs_bot_hint(&["Use --cookies-from-browser".into()]));
        assert!(!needs_bot_hint(&["ERROR: 404 Not Found".into()]));
    }

    #[test]
    fn format_retry_only_for_missing_formats() {
        assert!(needs_format_retry(&[
            "ERROR: [youtube] abc: Requested format is not available. Use --list-formats".into()
        ]));
        assert!(needs_format_retry(&[
            "ERROR: No video formats available for the requested format".into()
        ]));
        // bot 校验不能误判成格式问题，否则会白白多跑一轮 yt-dlp
        assert!(!needs_format_retry(&[
            "ERROR: [youtube] abc: Sign in to confirm you're not a bot".into()
        ]));
        assert!(!needs_format_retry(&["ERROR: 404 Not Found".into()]));
    }

    #[test]
    fn fallback_is_more_permissive_but_default_is_unchanged() {
        assert_eq!(DEFAULT_FORMAT, "bv*+ba/b", "正常路径必须保持原格式串");
        assert!(FALLBACK_FORMAT.starts_with(DEFAULT_FORMAT));
        assert!(FALLBACK_FORMAT.ends_with("/worst"));
        assert!(FALLBACK_CLIENTS.contains("android_vr"));
        assert!(FALLBACK_CLIENTS.contains("web_safari"));
        assert!(FORMAT_HINT.contains("PO Token"));
    }

    #[test]
    fn reload_retry_only_for_page_reload_errors() {
        assert!(needs_reload_retry(&[
            "ERROR: [youtube] abc: The page needs to be reloaded.".into()
        ]));
        assert!(needs_reload_retry(&[
            "ERROR: [youtube] abc: Please sign in to confirm you're not a bot".into()
        ]));
        // 格式问题不能误判成页面重载，否则会白白触发一次 yt-dlp 更新+重试
        assert!(!needs_reload_retry(&[
            "ERROR: [youtube] abc: Requested format is not available.".into()
        ]));
        assert!(!needs_reload_retry(&["ERROR: 404 Not Found".into()]));
    }
}
