//! 视频 / 音频任务：把整条链接交给 yt-dlp 子进程处理。
//!
//! 0.3.0 起的策略（方案 A：只服务国内站点）
//! ----------------------------------------
//! * **一次直下**：不再针对 YouTube 的 bot 挑战做「换客户端 → 更新 yt-dlp → 再重试」
//!   的多轮递归。旧实现失败时会连着跑三轮 yt-dlp，UI 上表现为「下载中 0 B / 未知」
//!   长时间空转，用户以为卡死。现在失败就是失败，报错即止，原因一眼可见。
//! * **不落凭证**：不再接收 / 写盘 cookies.txt，磁盘上不会留下任何登录态。
//! * **并发分片**：`--concurrent-fragments 4`，DASH / HLS 的音视频分片并发拉取，
//!   这是对 B 站、抖音这类分片流最直接的提速手段。
//! * **B 站客户端**：`--extractor-args bilibili:player_client=tv,app` 绕开 web 端最严
//!   的单连接限速（web 端匿名下载常年只有 ~120 KB/s）。

use crate::manager::{Engine, EngineError, TaskEntry};
use crate::types::*;
use crate::util;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const PROGRESS_TEMPLATE: &str = "download:FLUXDL|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.filename)s";

/// 默认格式选择：优先「最佳视频流 + 最佳音频流」合并，退到整体 best。
const DEFAULT_FORMAT: &str = "bv*+ba/b";

/// 分片并发数。国内站点的 DASH / HLS 流普遍支持多分片并发，
/// 4 路是在「提速明显」与「不触发风控」之间的折中值。
const CONCURRENT_FRAGMENTS: u8 = 4;

/// 单连接下载只有 ~120 KB/s 出头时，B 站 web 端几乎必然是瓶颈，换 tv/app 客户端。
const SLOW_SPEED_THRESHOLD: u64 = 300 * 1024;
/// 判定「慢」之前先观察这么久，避开 TCP 慢启动阶段。
const SLOW_SPEED_WINDOW: Duration = Duration::from_secs(15);

/// 逐行读取子进程输出，一直读到 EOF 才关闭读端。
///
/// 不能用 `BufReader::lines()`：它遇到非法 UTF-8 会返回 `Err`，旧实现写成
/// `while let Ok(Some(line))` 会因此提前退出、drop 掉 stdout 读端。Windows
/// 中文系统下 PyInstaller 版 `yt-dlp.exe` 的 stdout 默认走系统 ANSI 代码页
/// （GBK），进度模板里带中文文件名时就会产出非法 UTF-8 字节。管道读端一关，
/// yt-dlp 再写 stdout 拿到 Windows CRT 映射出来的 EINVAL(22)，于是报
/// `Unable to download video: [Errno 22] Invalid argument`，退出时 flush
/// 又抛一次 `Exception ignoring while flushing sys.stdout`。
///
/// 改为读原始字节 + lossy 解码：编码问题最多让某一行显示成乱码，不会中断下载。
fn spawn_line_reader<R>(reader: R, tx: mpsc::UnboundedSender<String>, prefix: &'static str)
where
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

/// 链接是否指向 B 站（含短链 b23.tv）。
///
/// 必须按「主机名」判断，不能用 `contains`：否则 `https://example.com/b23.tv-x`
/// 这种把域名写进路径的链接会被误判成 B 站，进而套上一个错误的提取器参数。
fn is_bilibili(url: &str) -> bool {
    let host = host_of(url);
    const HOSTS: &[&str] = &["bilibili.com", "b23.tv", "biliapi.net"];
    HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// 从 URL 里抽出小写主机名，去掉端口与 userinfo。不是合法 URL 时返回空串。
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let rest = rest.split(['/', '?', '#']).next().unwrap_or("");
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
    let rest = rest.split(':').next().unwrap_or("");
    rest.to_ascii_lowercase()
}

pub async fn run(
    engine: &Arc<Engine>,
    entry: &Arc<TaskEntry>,
    token: CancellationToken,
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
        // 分片流并发：B 站 / 抖音的 DASH 音视频都是分片下发，串行拉取等于自废带宽。
        .arg("--concurrent-fragments")
        .arg(CONCURRENT_FRAGMENTS.to_string())
        .arg("--progress-template")
        .arg(PROGRESS_TEMPLATE)
        .arg("--print")
        .arg("after_move:FLUXDONE|%(filepath)s")
        .arg("-P")
        .arg(&save_dir)
        .arg("-o")
        .arg("%(title).150B [%(id)s].%(ext)s")
        .arg("-f")
        .arg(entry.options.format.as_deref().unwrap_or(DEFAULT_FORMAT))
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

    // B 站：显式指定 tv / app 客户端。web 端匿名单连接被限速到 ~120 KB/s，
    // 而 tv/app 客户端拿到的下发地址限速宽松得多。
    if is_bilibili(&entry.url) {
        cmd.arg("--extractor-args").arg("bilibili:player_client=tv,app");
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
    let started = std::time::Instant::now();
    let mut speed_hinted = false;

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

                // 单连接长期低速时给一次可操作的提示（每个任务只提示一次）。
                if !speed_hinted
                    && started.elapsed() > SLOW_SPEED_WINDOW
                    && speed > 0
                    && speed < SLOW_SPEED_THRESHOLD
                {
                    speed_hinted = true;
                    engine.emit_log(
                        &entry.id,
                        "当前速度偏低：多为站点对单连接限速或本机网络瓶颈，可在设置里配置代理后重试",
                    );
                }

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
        let hint = failure_hint(&errors);
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

/// 把 yt-dlp 的英文报错翻译成一句中文可操作指引。
/// 0.3.0 只保留与国内站点相关的两类：不支持该站点 / 需要登录。
fn failure_hint(errors: &[String]) -> &'static str {
    let unsupported = errors.iter().any(|e| {
        e.contains("Unsupported URL")
            || e.contains("is not a valid URL")
            || e.contains("No video formats found")
    });
    if unsupported {
        return "（该链接不是受支持的视频页，或站点已改版。FluxDL 目前支持 B 站、抖音、快手、小红书、微博等国内站点；国外站点请使用其直链作为普通下载）";
    }
    let need_login = errors.iter().any(|e| {
        e.contains("login")
            || e.contains("Sign in")
            || e.contains("Premium")
            || e.contains("会员")
            || e.contains("DRM")
    });
    if need_login {
        return "（该内容需要登录或会员权限，FluxDL 不保存任何账号凭证，请改用普通下载任务或换可用来源）";
    }
    ""
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
fn find_new_output(dir: &Path, before: &HashMap<PathBuf, (u64, SystemTime)>) -> Option<PathBuf> {
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
    use super::*;
    use tokio::io::{duplex, AsyncWriteExt};

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
    fn default_format_prefers_video_plus_audio() {
        assert_eq!(DEFAULT_FORMAT, "bv*+ba/b");
        // 0.3.0 起不再有「放宽到 worst」的降级链
        assert!(!DEFAULT_FORMAT.contains("worst"));
    }

    #[test]
    fn concurrent_fragments_is_multiple_but_bounded() {
        assert!(CONCURRENT_FRAGMENTS >= 2, "并发至少 2 路才有意义");
        assert!(CONCURRENT_FRAGMENTS <= 8, "过高容易触发站点风控");
    }

    #[test]
    fn bilibili_detection_covers_short_link() {
        assert!(is_bilibili("https://www.bilibili.com/video/BV1xx"));
        assert!(is_bilibili("https://bilibili.com/video/BV1xx"));
        assert!(is_bilibili("https://b23.tv/abcd"));
        assert!(is_bilibili("http://m.bilibili.com/video/BV1xx?p=2"));
        assert!(!is_bilibili("https://www.douyin.com/video/1"));
        // 不能把「域名里碰巧含 b23.tv」的其它站点也算进来
        assert!(!is_bilibili("https://example.com/b23.tv-x"));
        assert!(!is_bilibili("https://notbilibili.com/x"));
        // 主机名比较要能穿透 userinfo 与端口
        assert!(is_bilibili("https://user:pw@b23.tv:443/abcd"));
    }

    #[test]
    fn unsupported_url_gets_actionable_hint() {
        let hint = failure_hint(&["ERROR: Unsupported URL: https://example.com".into()]);
        assert!(hint.contains("B 站"));
        assert!(hint.contains("普通下载"));
    }

    #[test]
    fn login_error_gets_credential_free_hint() {
        let hint = failure_hint(&["ERROR: This video requires login".into()]);
        assert!(hint.contains("不保存任何账号凭证"));
    }

    #[test]
    fn unknown_error_has_no_hint() {
        assert_eq!(failure_hint(&["ERROR: 404 Not Found".into()]), "");
    }
}
