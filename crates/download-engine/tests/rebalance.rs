//! A2 主动再平衡集成测试：慢段被分流后，最终文件字节必须完整且无重复写。
//!
//! 用受控服务器模拟「一段慢、一段快」：对 start=0 的首个 Range 请求延迟，
//! 让 run() 的周期采样判定段 0 落后并把它后半段交给新连接。分流涉及并发写
//! 同一 .part 文件的不同绝对区间，若边界计算或摘要对齐有 bug，最终字节
//! 会错乱或 finalize 校验失败——本测试正是这道回归防线。

use fluxdl_engine::*;
use rand::RngCore;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

struct Server {
    url: String,
    _handle: tokio::task::JoinHandle<()>,
    slow_hits: Arc<AtomicUsize>,
}

/// slow_first=true 时，首个 start=0 的 Range 请求延迟 delay 再发数据。
async fn start_server(payload: Arc<Vec<u8>>, slow_first: bool, delay: Duration) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}/payload.bin");
    let slow_hits = Arc::new(AtomicUsize::new(0));
    let slow_hits_bg = slow_hits.clone();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            let payload = payload.clone();
            let slow_hits = slow_hits_bg.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                {
                    let mut reader = BufReader::new(&mut socket);
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 { return; }
                        if line == "\r\n" { break; }
                        head.push(line);
                    }
                }
                let mut start = 0u64;
                for line in &head {
                    let lower = line.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("range:") {
                        let value = value.trim().trim_start_matches("bytes=");
                        if let Some((a, _)) = value.split_once('-') {
                            start = a.parse::<u64>().unwrap_or(0);
                        }
                    }
                }
                let total = payload.len() as u64;
                let end = total.saturating_sub(1);
                // start=0 的请求一律变慢，制造稳定慢段；其余连接正常速度。
                // （probe 的 bytes=0-0 与段 0 首请求都命中，保证采样时段 0 仍在延迟中。）
                if slow_first && start == 0 {
                    slow_hits.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(delay).await;
                }
                let header = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"payload.bin\"\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{total}\r\nConnection: close\r\n\r\n",
                    end - start + 1
                );
                if socket.write_all(header.as_bytes()).await.is_err() { return; }
                let mut pos = start as usize;
                while pos <= end as usize {
                    let stop = (pos + 64 * 1024).min(end as usize + 1);
                    if socket.write_all(&payload[pos..stop]).await.is_err() { return; }
                    pos = stop;
                }
                let _ = socket.flush().await;
            });
        }
    });
    Server { url, _handle: handle, slow_hits }
}

#[tokio::test(flavor = "multi_thread")]
async fn rebalance_keeps_bytes_intact() {
    let dir = tempfile::tempdir().unwrap();
    let mut payload = vec![0u8; 48 * 1024 * 1024];
    rand::thread_rng().fill_bytes(&mut payload);
    let expected = payload.clone();
    let server = start_server(Arc::new(payload), true, Duration::from_secs(5)).await;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(EngineOptions {
        save_dir: dir.path().to_string_lossy().to_string(),
        max_active: 4,
        connections: 2, // 48MB / 2 = 每段 24MB，满足分流阈值
        ..Default::default()
    }).await;

    let task = engine.add(TaskKind::Http, &server.url, NewTaskOptions::default()).await.unwrap();

    // 收集日志，确认确实触发过分流。
    let mut saw_split = false;
    let start = tokio::time::Instant::now();
    let mut completed = false;
    while start.elapsed() < Duration::from_secs(60) {
        tokio::select! {
            Some(ev) = rx.recv() => {
                if let EngineEvent::Log(line) = ev {
                    if line.message.contains("分流") { saw_split = true; }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if let Some(v) = engine.get_task(&task.id).await {
                    if v.status == TaskStatus::Completed { completed = true; break; }
                    if v.status == TaskStatus::Failed {
                        panic!("任务失败：{:?}", v.error);
                    }
                }
            }
        }
    }
    assert!(completed, "任务应在超时前完成");
    assert!(saw_split, "慢段场景应触发 A2 分流（未看到分流日志）");

    let bytes = std::fs::read(dir.path().join("payload.bin")).unwrap();
    assert_eq!(bytes.len(), expected.len(), "文件长度应完整");
    assert_eq!(bytes, expected, "分流后字节必须逐字节一致，不允许重叠写或丢字节");
    assert!(server.slow_hits.load(Ordering::SeqCst) >= 1, "慢段应被请求过");
}
