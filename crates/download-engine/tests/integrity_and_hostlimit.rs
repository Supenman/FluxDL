//! 阶段一 #4/#5 接线层集成测试。
//!
//! #4：服务器 `Repr-Digest` 真实性校验 —— 正确的摘要不误伤正常下载；
//!     错误的摘要阻止成品、任务判失败。
//! #5：HostLimits —— 单元层已在 host_limit.rs 覆盖 AIMD；本文件补充
//!     `HostLimits` 作为公开类型的行为契约（供上层接线引用）。

use base64::Engine as _;
use fluxdl_engine::host_limit::{FailureKind, HostLimits};
use fluxdl_engine::*;
use sha2::{Digest as _, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// 受控服务器：始终支持 Range，并可注入一个 `Repr-Digest` 头（正确/错误摘要）。
struct DigestServer {
    url: String,
    _handle: tokio::task::JoinHandle<()>,
}

async fn start_digest_server(payload: Arc<Vec<u8>>, repr_digest_b64: Option<String>) -> DigestServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}/payload.bin");
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            let payload = payload.clone();
            let repr = repr_digest_b64.clone();
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
                let mut header = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"payload.bin\"\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{total}\r\nETag: \"fixed\"\r\nConnection: close\r\n\r\n",
                    end - start + 1
                );
                if let Some(d) = &repr {
                    // 头必须在 \r\n\r\n 之前，重建一次
                    header = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"payload.bin\"\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{total}\r\nETag: \"fixed\"\r\nRepr-Digest: sha-256=:{d}:\r\nConnection: close\r\n\r\n",
                        end - start + 1
                    );
                }
                if socket.write_all(header.as_bytes()).await.is_err() { return; }
                let mut pos = start as usize;
                while pos <= end as usize {
                    let stop = (pos + 32 * 1024).min(end as usize + 1);
                    if socket.write_all(&payload[pos..stop]).await.is_err() { return; }
                    pos = stop;
                }
                let _ = socket.flush().await;
            });
        }
    });
    DigestServer { url, _handle: handle }
}

fn options(dir: &std::path::Path) -> EngineOptions {
    EngineOptions {
        save_dir: dir.to_string_lossy().to_string(),
        max_active: 4,
        connections: 4,
        ..Default::default()
    }
}

async fn wait_status(engine: &Arc<Engine>, id: &str, timeout: Duration, terminal: &[TaskStatus]) -> TaskView {
    let start = Instant::now();
    loop {
        let view = engine.get_task(id).await.expect("task missing");
        if terminal.contains(&view.status) {
            return view;
        }
        if start.elapsed() > timeout {
            panic!("timeout waiting for {terminal:?}, last: {view:?}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn correct_repr_digest_does_not_block_download() {
    let dir = tempfile::tempdir().unwrap();
    let payload = Arc::new({
        let mut v = vec![0u8; 256 * 1024];
        // 固定内容，便于算摘要
        for (i, b) in v.iter_mut().enumerate() { *b = (i % 251) as u8; }
        v
    });
    let good = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(&payload[..]));
    let server = start_digest_server(payload.clone(), Some(good)).await;

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(options(dir.path())).await;
    let task = engine
        .add(TaskKind::Http, &server.url, NewTaskOptions::default())
        .await
        .unwrap();
    // 新建任务默认需审核，先放行
    engine.approve(&task.id).await;

    let view = wait_status(&engine, &task.id, Duration::from_secs(20), &[TaskStatus::Completed]).await;
    assert_eq!(view.status, TaskStatus::Completed, "正确摘要不应误伤下载: {view:?}");

    // 成品字节必须与源一致
    let saved = std::fs::read(&view.save_path).unwrap();
    assert_eq!(saved.as_slice(), &payload[..]);
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_repr_digest_blocks_corrupted_file() {
    let dir = tempfile::tempdir().unwrap();
    let payload = Arc::new(vec![0x5Au8; 128 * 1024]);
    // 故意用一个错误摘要（全 0）触发真实性失败
    let bad = base64::engine::general_purpose::STANDARD.encode([0u8; 32]);
    let server = start_digest_server(payload, Some(bad)).await;

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(options(dir.path())).await;
    let task = engine
        .add(TaskKind::Http, &server.url, NewTaskOptions::default())
        .await
        .unwrap();
    engine.approve(&task.id).await;

    let view = wait_status(&engine, &task.id, Duration::from_secs(20), &[TaskStatus::Failed]).await;
    assert_eq!(view.status, TaskStatus::Failed, "错误摘要应判失败: {view:?}");
    let err = view.error.unwrap_or_default();
    assert!(err.contains("校验值不符"), "错误提示应指向真实性校验: {err}");
    // 不能留下损坏成品
    assert!(!std::path::Path::new(&view.save_path).exists(), "不应产出损坏文件");
}

#[test]
fn host_limits_public_api_contract() {
    // 上层接线依赖这些公开类型/方法的稳定行为。
    let mut limits = HostLimits::new();
    // 初始 ceiling=32：requested=32 原样放行
    assert_eq!(limits.suggest("https://cdn.example.com/a", 32), 32);
    // 一次 429 → ceiling 减半到 16，建议值随之收敛
    limits.on_failure("https://cdn.example.com/a", FailureKind::TooManyRequests);
    assert_eq!(limits.suggest("https://cdn.example.com/a", 32), 16);
    // 主机隔离：另一台不受影响
    assert_eq!(limits.suggest("https://other.example.com/a", 32), 32);
}
