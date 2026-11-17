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
    // 原来 probe 只发一次，网络抖动或临时 5xx 就把整个任务判失败，
    // 而分段下载本身有重试。这里补齐探测阶段的临时错误重试，规则与
    // segment_loop 一致：网络错误/超时/5xx 重试，4xx 等确定性错误直接返回。
    let mut last_error: Option<EngineError> = None;
    for attempt in 0..=RETRIES {
        if token.is_cancelled() {
            return Err(EngineError::Paused);
        }
        if attempt > 0 {
            tokio::select! {
                _ = token.cancelled() => return Err(EngineError::Paused),
                _ = tokio::time::sleep(Duration::from_millis(500 * (1u64 << attempt))) => {}
            }
        }
        let req = apply_headers(client.get(&entry.url), entry).header(RANGE, "bytes=0-0");
        let resp = tokio::select! {
            _ = token.cancelled() => return Err(EngineError::Paused),
            r = tokio::time::timeout(Duration::from_secs(25), req.send()) => match r {
                Err(_) => {
                    last_error = Some(EngineError::message("连接超时，请检查网络或代理"));
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
        if status.is_server_error() {
            last_error = Some(EngineError::message(format!(
                "服务器返回 HTTP {}，无法下载",
                status.as_u16()
            )));
            continue;
        }
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
        // A3 启动优化：Range 探测（bytes=0-0）的响应体只有 1 字节，消费掉它，
        // 让这条刚建好的连接回到 keep-alive 池，首个分段可直接复用，
        // 省掉一次 TCP/TLS 握手（弱网/HTTPS 下可感知）。
        // 服务器忽略 Range 返回整文件（status=200）时不消费，避免把整文件读进内存；
        // 那种场景 ranges=false 走单连接，本就无握手可省。
        if status == StatusCode::PARTIAL_CONTENT {
            let _ = tokio::time::timeout(Duration::from_secs(5), resp.bytes()).await;
        } else {
            drop(resp);
        }

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

        return Ok(Probe {
            total,
            ranges,
            filename: util::filename_from_headers(&headers),
            mime: headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string()),
        });
    }
    Err(last_error.unwrap_or_else(|| EngineError::message("探测失败")))
}

/// 把单个分段交给一条新连接。原段与 A2 分流出的新段共用此入口。
fn spawn_segment(
    set: &mut JoinSet<Result<Option<util::SegmentDigest>, EngineError>>,
    seg: &SegmentView,
    engine: &Arc<Engine>,
    entry: &Arc<TaskEntry>,
    client: &Client,
    file: &Arc<std::fs::File>,
    token: &CancellationToken,
) {
    let seg = seg.clone();
    let client = client.clone();
    let entry = entry.clone();
    let file = file.clone();
    let token = token.clone();
    let global = engine.global_limit();
    let engine = engine.clone();
    set.spawn(async move {
        segment_loop(engine, entry, seg, client, file, token, global).await
    });
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
        // A1 自适应：conns 是用户上限，按体积收敛后规划分段；续传沿用历史分段数不改。
        let effective = util::effective_connections(conns, total, probe.ranges);
        segments = util::plan_segments(total, effective)
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
        let (position, digest) = sequential_stream(
            engine,
            entry,
            &client,
            &file,
            token.clone(),
            total,
        )
        .await?;
        // 不可续传的单流同样做写后回读校验，校验通过才落成最终文件。
        finalize_verified(&entry, &file, &part_path, &save_path, &[digest]).await?;
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
        // 全部为历史续传分段，本次运行没有写盘字节，无需回读校验（旧字节已在各自
        // 写入那一次校验过）；part 长度在上方 P0-2 处已核对过等于 total。
        finish_file(&part_path, &save_path).await?;
        return Ok(());
    }

    let mut set: JoinSet<Result<Option<util::SegmentDigest>, EngineError>> = JoinSet::new();
    for seg in segments.iter() {
        if seg.done || seg.downloaded >= seg.length() {
            continue;
        }
        spawn_segment(&mut set, seg, &engine, &entry, &client, &file, &token);
    }

    let mut first_error: Option<EngineError> = None;
    let mut digests: Vec<util::SegmentDigest> = Vec::new();
    let mut splits_used = 0usize;
    // A2：慢连接判定与分流只在「无主动限速」时启用——限速下低吞吐是人为的。
    let rebalance_enabled = entry.limiter.limit().is_none() && engine.global_limit().limit().is_none();
    let mut tick = tokio::time::interval(Duration::from_secs(util::REBALANCE_TICK_SECS));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await; // 消费首拍，从现在开始计时

    while !set.is_empty() {
        tokio::select! {
            joined = set.join_next() => {
                match joined {
                    Some(Ok(Ok(Some(d)))) => digests.push(d),
                    Some(Ok(Ok(None))) => {}
                    Some(Ok(Err(err))) => {
                        first_error = Some(err);
                        set.abort_all();
                        break;
                    }
                    Some(Err(join_err)) => {
                        first_error = Some(EngineError::message(format!("下载线程异常：{join_err}")));
                        set.abort_all();
                        break;
                    }
                    None => {}
                }
            }
            _ = tick.tick(), if rebalance_enabled => {
                // 采样各段快照，判定是否有明显落后的段。
                let laggard = {
                    let segs = entry.segments.lock();
                    let downloaded: Vec<u64> = segs.iter().map(|s| s.downloaded).collect();
                    let lengths: Vec<u64> = segs.iter().map(|s| s.length()).collect();
                    let done: Vec<bool> = segs.iter().map(|s| s.done).collect();
                    util::rebalance_laggard(&downloaded, &lengths, &done, splits_used)
                };
                let Some(idx) = laggard else { continue };
                // 收缩慢段 end 到「已下载位置 + 剩余的一半」，把后半段交给新连接。
                let split_seg = {
                    let mut segs = entry.segments.lock();
                    let seg = &mut segs[idx];
                    let start = seg.start;
                    let pos = start.saturating_add(seg.downloaded);
                    let old_end = seg.end;
                    if old_end <= pos || seg.done {
                        continue;
                    }
                    let mid = pos.saturating_add((old_end - pos) / 2);
                    if mid >= old_end {
                        continue;
                    }
                    seg.end = mid; // 原段只负责到 mid
                    let new_index = segs.len();
                    let new_seg = SegmentView {
                        index: new_index,
                        start: mid.saturating_add(1),
                        end: old_end,
                        downloaded: 0,
                        done: false,
                    };
                    segs.push(new_seg.clone());
                    splits_used += 1;
                    new_seg
                };
                engine.emit_log(&entry.id, format!(
                    "检测到落后分段 #{idx}，已分流一条连接协助下载（第 {splits_used} 次）"
                ));
                spawn_segment(&mut set, &split_seg, &engine, &entry, &client, &file, &token);
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

    // 所有分段写盘完毕后、落成最终文件之前，逐段回读重算 SHA-256 比对。
    // 任何不一致都拒绝产出最终文件（见 finalize_verified）。
    finalize_verified(&entry, &file, &part_path, &save_path, &digests).await?;
    let mut view = entry.view.lock().await;
    view.downloaded_bytes = total;
    drop(view);
    Ok(())
}

async fn segment_loop(
    engine: Arc<Engine>,
    entry: Arc<TaskEntry>,
    seg: SegmentView,
    client: Client,
    file: Arc<std::fs::File>,
    token: CancellationToken,
    global: Arc<RateLimiter>,
) -> Result<Option<util::SegmentDigest>, EngineError> {
    let index = seg.index;
    let start = seg.start;
    // A2：end 为可变共享边界。主循环分流时会收缩慢段的 end 并另起连接，
    // 本连接每轮从 entry.segments 读回最新 end，写到新边界即收尾，避免重叠写。
    let mut end = seg.end;
    let mut pos = start.saturating_add(seg.downloaded);
    // 本次运行真正写下的字节区间：从续传起点开始（历史字节不纳入本次校验，
    // 它们在此前的运行里已校验过，或至少从未被本次响应体重新提供）。
    let digest_start = pos;
    let mut sink = util::DigestSink::new();
    let mut last_error: Option<EngineError> = None;
    // 慢连接判定：任务级或全局限速开启时吞吐低是人为的，绝不当成慢线路。
    let stall_enabled = entry.limiter.limit().is_none() && global.limit().is_none();
    let mut watch = util::StallWatch::new(0.0);
    let clock = std::time::Instant::now();
    // 换线不消耗 RETRIES（错误重试预算）：换线是主动优化，不是失败。
    let mut attempts_left = RETRIES;

    loop {
        // A2：每轮读回共享边界。若本段已被分流，end 会被收缩到切点，
        // 写到切点即自然收尾（pos > end），后半段由新连接负责。
        {
            let segs = entry.segments.lock();
            if let Some(shared) = segs.get(index) {
                end = shared.end;
            }
        }
        if pos > end {
            mark_segment(&entry, index, end + 1);
            return Ok(Some(sink.finish(digest_start, pos)));
        }
        if token.is_cancelled() {
            return Err(EngineError::Paused);
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
                return Ok(Some(sink.finish(digest_start, pos)));
            }
            let err = EngineError::message(format!("分段请求失败：HTTP {}", status.as_u16()));
            if status.is_client_error() {
                return Err(err);
            }
            last_error = Some(err);
            continue;
        }

        // 一条连接的 chunk 循环。心跳分支与数据分支在 select 内各自内联处理，
        // 让「零字节死连接」也能被观测到；分支都只借用自己那一份状态，互不干扰。
        let mut stream = resp.bytes_stream();
        let mut clean_end = false;
        let mut swapped = false;
        let mut tick = tokio::time::interval(Duration::from_secs(util::STALL_TICK_SECS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // 消费立即触发的第一拍，让计时从现在开始
        loop {
            tokio::select! {
                _ = token.cancelled() => return Err(EngineError::Paused),
                _ = tick.tick() => {
                    if stall_enabled {
                        let now = clock.elapsed().as_secs_f64();
                        let remaining = end.saturating_sub(pos).saturating_add(1);
                        if watch.observe(now, 0, remaining, true) {
                            swapped = true;
                        }
                    }
                }
                item = stream.next() => {
                    match item {
                        None => clean_end = true,
                        Some(Err(e)) => last_error = Some(EngineError::Http(e)),
                        Some(Ok(chunk)) => {
                            if !chunk.is_empty() {
                                let len = chunk.len() as u64;
                                entry.limiter.acquire(len).await;
                                global.acquire(len).await;
                                if token.is_cancelled() {
                                    return Err(EngineError::Paused);
                                }
                                util::write_at(&file, &chunk, pos)?;
                                // 增量摘要与写盘用同一批字节，保证「网络字节 == 落盘字节」可比。
                                sink.update(&chunk);
                                pos += len;
                                entry.downloaded.fetch_add(len, Ordering::Relaxed);
                                mark_segment(&entry, index, pos - start);
                                if stall_enabled {
                                    let now = clock.elapsed().as_secs_f64();
                                    let remaining = end.saturating_sub(pos).saturating_add(1);
                                    if watch.observe(now, len, remaining, true) {
                                        swapped = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if swapped || clean_end || last_error.is_some() || pos > end {
                break;
            }
        }

        if pos > end {
            mark_segment(&entry, index, pos - start);
            return Ok(Some(sink.finish(digest_start, pos)));
        }
        if swapped {
            // 换线：从已写到的 pos 重新发 Range（换一条连接），重置热身/窗口，
            // 但不消耗错误重试预算、也不丢弃已写字节。
            watch.on_reconnect(clock.elapsed().as_secs_f64());
            engine.emit_log(
                &entry.id,
                format!("连接速率过低，正在换线重连（第 {} 次）", watch.swaps()),
            );
            continue;
        }
        if clean_end {
            last_error = Some(EngineError::message("分段连接提前结束，正在重试"));
        }
        if attempts_left == 0 {
            break;
        }
        attempts_left -= 1;
        tokio::select! {
            _ = token.cancelled() => return Err(EngineError::Paused),
            _ = tokio::time::sleep(Duration::from_millis(500 * (1u64 << (RETRIES - attempts_left)))) => {}
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
) -> Result<(u64, util::SegmentDigest), EngineError> {
    let mut position = 0u64;
    let mut attempt = 0usize;
    let global = engine.global_limit();
    // 不可续传的单流同样增量算摘要：写盘字节与网络字节用同一批数据。
    // 每次 restart 会把文件截断、position 归零，摘要也要一起重来。
    let mut sink = util::DigestSink::new();

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
                    restart_stream(entry, file, &mut position, &mut sink)?;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                Ok(Err(e)) => {
                    if attempt >= RETRIES { return Err(EngineError::Http(e)); }
                    attempt += 1;
                    restart_stream(entry, file, &mut position, &mut sink)?;
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
                        restart_stream(entry, file, &mut position, &mut sink)?;
                        break;
                    }
                    return Ok((position, sink.finish(0, position)));
                }
                Some(Err(e)) => {
                    if attempt >= RETRIES {
                        return Err(EngineError::Http(e));
                    }
                    attempt += 1;
                    restart_stream(entry, file, &mut position, &mut sink)?;
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
                    sink.update(&chunk);
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
    sink: &mut util::DigestSink,
) -> Result<(), EngineError> {
    *position = 0;
    entry.downloaded.store(0, Ordering::Relaxed);
    file.set_len(0)?;
    *sink = util::DigestSink::new();
    Ok(())
}

/// 写后回读校验：逐段重算 SHA-256 与写盘时的摘要比对。
///
/// 校验不通过 = 磁盘上的字节与我们收到的字节不一致（稀疏空洞、越界覆盖、
/// 写未落盘 …）。此时**绝不**把 .part rename 成最终文件：删掉 part、把进度
/// 与分段清零，让用户重试时全量重下，杜绝「大小正确却打不开」的损坏成品。
async fn finalize_verified(
    entry: &TaskEntry,
    file: &std::fs::File,
    part: &Path,
    final_path: &Path,
    digests: &[util::SegmentDigest],
) -> Result<(), EngineError> {
    let verdict = util::verify_regions(file, digests);
    let problem = match verdict {
        Ok(None) => None,
        Ok(Some(idx)) => Some(format!(
            "分片 {idx} 写盘校验失败：下载内容与落盘内容不一致"
        )),
        Err(e) => Some(format!("写盘回读校验失败：{e}")),
    };
    let Some(problem) = problem else {
        return finish_file(part, final_path).await;
    };
    // 丢弃损坏的 part，并清空续传状态，强制下次从 0 开始。
    tokio::fs::remove_file(part).await.ok();
    entry.downloaded.store(0, Ordering::Relaxed);
    entry.segments.lock().clear();
    Err(EngineError::message(format!(
        "{problem}，已阻止保存损坏文件，请重试该任务重新下载"
    )))
}

async fn finish_file(part: &Path, final_path: &Path) -> Result<(), EngineError> {
    if final_path.exists() {
        tokio::fs::remove_file(final_path).await.ok();
    }
    tokio::fs::rename(part, final_path).await?;
    Ok(())
}
