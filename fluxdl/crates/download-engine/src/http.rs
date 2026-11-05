use crate::limit::RateLimiter;
use crate::manager::{Engine, EngineError, TaskEntry};
use crate::types::*;
use crate::util;
use futures_util::StreamExt;
use reqwest::header::{
    HeaderName, HeaderValue, ACCEPT_RANGES, CONTENT_LENGTH, RANGE, REFERER,
};
use reqwest::{Client, StatusCode};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

const RETRIES: usize = 3;

struct Probe {
    total: u64,
    ranges: bool,
    filename: Option<String>,
    mime: Option<String>,
}

pub(crate) fn build_client(
    entry: &TaskEntry,
    options: &EngineOptions,
) -> Result<Client, EngineError> {
    let proxy = entry.proxy.clone().or_else(|| options.proxy.clone());
    let mut builder = Client::builder()
        .user_agent(entry.user_agent.clone())
        .connect_timeout(Duration::from_secs(20))
        .pool_max_idle_per_host(24);
    if let Some(proxy) = proxy.filter(|p| !p.trim().is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy.trim())?);
    }
    Ok(builder.build()?)
}

fn apply_headers(mut req: reqwest::RequestBuilder, entry: &TaskEntry) -> reqwest::RequestBuilder {
    if let Some(referer) = entry.options.referer.as_deref().filter(|s| !s.is_empty()) {
        if let Ok(value) = HeaderValue::from_str(referer) {
            req = req.header(REFERER, value);
        }
    }
    for (name, value) in &entry.options.headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            req = req.header(name, value);
        }
    }
    req
}

async fn probe(
    client: &Client,
    entry: &TaskEntry,
    token: &CancellationToken,
) -> Result<Probe, EngineError> {
    let req = apply_headers(client.get(&entry.url), entry).header(RANGE, "bytes=0-0");
    let resp = tokio::select! {
        _ = token.cancelled() => return Err(EngineError::Paused),
        r = tokio::time::timeout(Duration::from_secs(25), req.send()) => {
            match r {
                Err(_) => return Err(EngineError::message("连接超时，请检查网络或代理")),
                Ok(Err(e)) => return Err(EngineError::Http(e)),
                Ok(Ok(resp)) => resp,
            }
        }
    };

    let status = resp.status();
    if !status.is_success() && status != StatusCode::RANGE_NOT_SATISFIABLE {
        return Err(EngineError::message(format!(
            "服务器返回 HTTP {}，无法下载",
            status.as_u16()
        )));
    }
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Err(EngineError::message(
            "服务器拒绝 Range 请求（文件可能为空或链接已失效）",
        ));
    }

    let headers = resp.headers().clone();
    drop(resp);

    let total = util::total_from_content_range(&headers)
        .or_else(|| {
            headers
                .get(CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
        })
        .unwrap_or(0);

    let ranges = status == StatusCode::PARTIAL_CONTENT
        && headers
            .get(ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_ascii_lowercase().contains("bytes"))
            .unwrap_or(true);

    Ok(Probe {
        total,
        ranges,
        filename: util::filename_from_headers(&headers),
        mime: headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string()),
    })
}

pub async fn run(
    engine: &Arc<Engine>,
    entry: &Arc<TaskEntry>,
    token: CancellationToken,
) -> Result<(), EngineError> {
    let options = engine.options();
    let client = build_client(entry, &options)?;
    let probe = probe(&client, entry, &token).await?;

    let (stored_total, conns, stored_path) = {
        let view = entry.view.lock().await;
        (view.total_bytes, view.connections, PathBuf::from(&view.save_path))
    };

    let prev_bytes = entry.downloaded.load(Ordering::Relaxed);
    let prev_segments = entry.segments.lock().clone();

    let mut total = probe.total;
    if total == 0 {
        total = stored_total;
    }
    let resumable = probe.ranges && total > 0;
    let mut effective_resume = resumable
        && stored_total == total
        && prev_bytes > 0
        && !prev_segments.is_empty();

    let mut save_path = stored_path.clone();
    let mut renamed = false;
    if !effective_resume {
        if let Some(name) = &probe.filename {
            let current = save_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            // 服务器给的名字优先，但不要用一个泛化名替换掉有意义的名字。
            let trusted = (entry.options.filename.is_none() || entry.options.prefer_header_filename)
                && (!util::looks_generic(name) || util::looks_generic(&current));
            if trusted {
                let dir = save_path.parent().unwrap_or(Path::new("."));
                let candidate = util::unique_path(dir, name);
                if candidate != save_path {
                    save_path = candidate;
                    renamed = true;
                }
            }
        }
    }

    // P0-2 修复：续传必须以磁盘上的 part 为准，且必须在「规划分段」之前判定。
    // 若 part 不存在、长度与远端总长不符，或目标已被改名，则不能跳过任何分段，
    // 否则 set_len 会把空文件补成完整长度，产生「长度正确但内容是 0」的损坏文件。
    let part_path = PathBuf::from(format!("{}.fluxdl-part", save_path.to_string_lossy()));
    if effective_resume {
        let part_len = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        if renamed || total == 0 || part_len != total {
            effective_resume = false;
            entry.downloaded.store(0, Ordering::Relaxed);
            entry.segments.lock().clear();
        }
    }

    let mut segments: Vec<SegmentView> = if effective_resume {
        prev_segments
    } else {
        Vec::new()
    };
    if resumable && (segments.is_empty() || !effective_resume) {
        segments = util::plan_segments(total, conns)
            .into_iter()
            .enumerate()
            .map(|(i, (start, end))| SegmentView {
                index: i,
                start,
                end,
                downloaded: 0,
                done: false,
            })
            .collect();
    }
    if !resumable {
        segments.clear();
    }

    if !effective_resume {
        entry.downloaded.store(0, Ordering::Relaxed);
    }
    let resumed_bytes: u64 = segments.iter().map(|s| s.downloaded).sum();
    if effective_resume {
        entry.downloaded.store(resumed_bytes, Ordering::Relaxed);
    }

    util::ensure_dir(save_path.parent().unwrap_or(Path::new(".")))?;

    // A fresh attempt (or a changed remote file) must not inherit stale bytes.
    if renamed || !effective_resume {
        let old_part = PathBuf::from(format!("{}.fluxdl-part", stored_path.to_string_lossy()));
        if old_part.exists() {
            tokio::fs::remove_file(&old_part).await.ok();
        }
        if part_path.exists() {
            tokio::fs::remove_file(&part_path).await.ok();
        }
    }

    {
        let mut view = entry.view.lock().await;
        view.save_path = save_path.to_string_lossy().to_string();
        view.filename = save_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| view.filename.clone());
        view.total_bytes = total;
        view.mime = probe.mime;
        view.resumable = resumable;
        view.connections = segments.len().max(1) as u8;
        view.status = TaskStatus::Downloading;
        view.segments = segments.clone();
    }
    *entry.segments.lock() = segments.clone();
    engine.emit_task(entry).await;

    let file = {
        let f = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&part_path)?;
        if total > 0 {
            let len = f.metadata()?.len();
            if len != total {
                f.set_len(total)?;
            }
        }
        Arc::new(f)
    };

    if !resumable {
        let position = sequential_stream(
            engine,
            entry,
            &client,
            &file,
            token.clone(),
            total,
        )
        .await?;
        finish_file(&part_path, &save_path).await?;
        let mut view = entry.view.lock().await;
        view.total_bytes = if total > 0 { total } else { position };
        view.downloaded_bytes = position;
        drop(view);
        return Ok(());
    }

    if segments
        .iter()
        .all(|s| s.done || s.downloaded >= s.length())
    {
        finish_file(&part_path, &save_path).await?;
        return Ok(());
    }

    let mut set: JoinSet<Result<(), EngineError>> = JoinSet::new();
    for seg in segments.iter() {
        if seg.done || seg.downloaded >= seg.length() {
            continue;
        }
        let seg = seg.clone();
        let client = client.clone();
        let entry = entry.clone();
        let file = file.clone();
        let token = token.clone();
        let global = engine.global_limit();
        set.spawn(async move {
            segment_loop(
                entry,
                seg,
                client,
                file,
                token,
                global,
            )
            .await
        });
    }

    let mut first_error: Option<EngineError> = None;
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                first_error = Some(err);
                set.abort_all();
                break;
            }
            Err(join_err) => {
                first_error = Some(EngineError::message(format!("下载线程异常：{join_err}")));
                set.abort_all();
                break;
            }
        }
    }

    if token.is_cancelled() {
        return Err(EngineError::Paused);
    }
    if let Some(err) = first_error {
        return Err(err);
    }

    let done = entry.downloaded.load(Ordering::Relaxed);
    if done < total {
        return Err(EngineError::message(format!(
            "连接提前结束，仅下载 {done} / {total} 字节"
        )));
    }

    finish_file(&part_path, &save_path).await?;
    let mut view = entry.view.lock().await;
    view.downloaded_bytes = total;
    drop(view);
    Ok(())
}

async fn segment_loop(
    entry: Arc<TaskEntry>,
    seg: SegmentView,
    client: Client,
    file: Arc<std::fs::File>,
    token: CancellationToken,
    global: Arc<RateLimiter>,
) -> Result<(), EngineError> {
    let index = seg.index;
    let start = seg.start;
    let end = seg.end;
    let mut pos = start.saturating_add(seg.downloaded);
    let mut last_error: Option<EngineError> = None;

    for attempt in 0..=RETRIES {
        if pos > end {
            mark_segment(&entry, index, end + 1);
            return Ok(());
        }
        if token.is_cancelled() {
            return Err(EngineError::Paused);
        }
        if attempt > 0 {
            tokio::select! {
                _ = token.cancelled() => return Err(EngineError::Paused),
                _ = tokio::time::sleep(Duration::from_millis(500 * (1u64 << attempt))) => {}
            }
        }

        let req = apply_headers(client.get(&entry.url), &entry)
            .header(RANGE, format!("bytes={pos}-{end}"));
        let resp = tokio::select! {
            _ = token.cancelled() => return Err(EngineError::Paused),
            r = tokio::time::timeout(Duration::from_secs(30), req.send()) => match r {
                Err(_) => {
                    last_error = Some(EngineError::message("分段连接超时"));
                    continue;
                }
                Ok(Err(e)) => {
                    last_error = Some(EngineError::Http(e));
                    continue;
                }
                Ok(Ok(resp)) => resp,
            }
        };

        let status = resp.status();
        if status != StatusCode::PARTIAL_CONTENT {
            if status == StatusCode::OK {
                return Err(EngineError::message("服务器忽略 Range 请求，无法多线程下载"));
            }
            if status == StatusCode::RANGE_NOT_SATISFIABLE {
                // Already at the end (server sees no remaining bytes).
                mark_segment(&entry, index, end + 1);
                return Ok(());
            }
            let err = EngineError::message(format!("分段请求失败：HTTP {}", status.as_u16()));
            if status.is_client_error() {
                return Err(err);
            }
            last_error = Some(err);
            continue;
        }

        let mut stream = resp.bytes_stream();
        let mut clean_end = false;
        loop {
            let next = tokio::select! {
                _ = token.cancelled() => return Err(EngineError::Paused),
                item = stream.next() => item,
            };
            match next {
                None => {
                    clean_end = true;
                    break;
                }
                Some(Err(e)) => {
                    last_error = Some(EngineError::Http(e));
                    break;
                }
                Some(Ok(chunk)) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    let len = chunk.len() as u64;
                    entry.limiter.acquire(len).await;
                    global.acquire(len).await;
                    if token.is_cancelled() {
                        return Err(EngineError::Paused);
                    }
                    util::write_at(&file, &chunk, pos)?;
                    pos += len;
                    entry.downloaded.fetch_add(len, Ordering::Relaxed);
                    mark_segment(&entry, index, pos - start);
                    if pos > end {
                        break;
                    }
                }
            }
        }

        if pos > end {
            mark_segment(&entry, index, pos - start);
            return Ok(());
        }
        if clean_end {
            last_error = Some(EngineError::message("分段连接提前结束，正在重试"));
        }
    }

    Err(last_error.unwrap_or_else(|| EngineError::message("下载失败")))
}

fn mark_segment(entry: &TaskEntry, index: usize, downloaded: u64) {
    let mut segs = entry.segments.lock();
    if let Some(seg) = segs.get_mut(index) {
        let len = seg.length();
        seg.downloaded = downloaded.min(len);
        seg.done = downloaded >= len;
    }
}

async fn sequential_stream(
    engine: &Arc<Engine>,
    entry: &Arc<TaskEntry>,
    client: &Client,
    file: &Arc<std::fs::File>,
    token: CancellationToken,
    known_total: u64,
) -> Result<u64, EngineError> {
    let mut position = 0u64;
    let mut attempt = 0usize;
    let global = engine.global_limit();

    loop {
        if token.is_cancelled() {
            return Err(EngineError::Paused);
        }
        let req = apply_headers(client.get(&entry.url), entry);
        let resp = tokio::select! {
            _ = token.cancelled() => return Err(EngineError::Paused),
            r = tokio::time::timeout(Duration::from_secs(30), req.send()) => match r {
                Err(_) => {
                    if attempt >= RETRIES { return Err(EngineError::message("连接超时")); }
                    attempt += 1;
                    restart_stream(entry, file, &mut position)?;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                Ok(Err(e)) => {
                    if attempt >= RETRIES { return Err(EngineError::Http(e)); }
                    attempt += 1;
                    restart_stream(entry, file, &mut position)?;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                Ok(Ok(r)) => r,
            }
        };
        if !resp.status().is_success() {
            return Err(EngineError::message(format!(
                "服务器返回 HTTP {}",
                resp.status().as_u16()
            )));
        }
        let mut stream = resp.bytes_stream();
        loop {
            let next = tokio::select! {
                _ = token.cancelled() => return Err(EngineError::Paused),
                item = stream.next() => item,
            };
            match next {
                None => {
                    if known_total > 0 && position < known_total {
                        if attempt >= RETRIES {
                            return Err(EngineError::message("连接提前结束，文件可能不完整"));
                        }
                        attempt += 1;
                        restart_stream(entry, file, &mut position)?;
                        break;
                    }
                    return Ok(position);
                }
                Some(Err(e)) => {
                    if attempt >= RETRIES {
                        return Err(EngineError::Http(e));
                    }
                    attempt += 1;
                    restart_stream(entry, file, &mut position)?;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    break;
                }
                Some(Ok(chunk)) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    let len = chunk.len() as u64;
                    entry.limiter.acquire(len).await;
                    global.acquire(len).await;
                    if token.is_cancelled() {
                        return Err(EngineError::Paused);
                    }
                    util::write_at(file, &chunk, position)?;
                    position += len;
                    entry.downloaded.store(position, Ordering::Relaxed);
                }
            }
        }
    }
}

fn restart_stream(
    entry: &TaskEntry,
    file: &std::fs::File,
    position: &mut u64,
) -> Result<(), EngineError> {
    *position = 0;
    entry.downloaded.store(0, Ordering::Relaxed);
    file.set_len(0)?;
    Ok(())
}

async fn finish_file(part: &Path, final_path: &Path) -> Result<(), EngineError> {
    if final_path.exists() {
        tokio::fs::remove_file(final_path).await.ok();
    }
    tokio::fs::rename(part, final_path).await?;
    Ok(())
}
