use crate::manager::{Engine, EngineError, TaskEntry};
use crate::types::*;
use crate::util;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const PROGRESS_TEMPLATE: &str = "download:FLUXDL|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.filename)s";

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
        .arg(entry.options.format.as_deref().unwrap_or("bv*+ba/b"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

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
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(line);
            }
        });
    }
    if let Some(stderr) = stderr {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(format!("ERR|{line}"));
            }
        });
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
        return Err(EngineError::message(if tail.is_empty() {
            format!("yt-dlp 退出码 {:?}", status.code())
        } else {
            format!("yt-dlp 失败：{tail}")
        }));
    }

    let mut resolved = final_path.clone();
    if resolved.as_ref().map(|p| !p.exists()).unwrap_or(true) {
        resolved = find_output(&save_dir, &placeholder);
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
