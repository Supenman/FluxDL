//! B2 定时下载集成测试：验证定时任务到点前保持暂停、到点后自动启动并清空计划标记。
//! 用真实本地 HTTP 服务器 + 短未来时间，避免 tokio 时间暂停对引擎内部 tick/超时的干扰。

use fluxdl_engine::*;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

struct TestServer {
    _handle: tokio::task::JoinHandle<()>,
}

async fn start_server(payload: Arc<Vec<u8>>) -> (String, TestServer) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}/payload.bin");
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            let payload = payload.clone();
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
                let total = payload.len() as u64;
                let mut start = 0u64;
                for line in &head {
                    let lower = line.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("range:") {
                        let value = value.trim().trim_start_matches("bytes=");
                        if let Some((a, _)) = value.split_once('-') {
                            start = a.parse::<u64>().unwrap_or(0).min(total.saturating_sub(1));
                        }
                    }
                }
                let has_range = head.iter().any(|l| l.to_ascii_lowercase().starts_with("range:"));
                let end = total.saturating_sub(1);
                let status = if has_range { "206 Partial Content" } else { "200 OK" };
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"payload.bin\"\r\nConnection: close\r\n\r\n",
                    end - start + 1
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(&payload[start as usize..=end as usize]).await;
                let _ = socket.flush().await;
            });
        }
    });
    (url, TestServer { _handle: handle })
}

fn engine_at(dir: &std::path::Path) -> Arc<Engine> {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    Engine::new(dir.join("tasks.json"), tx)
}

#[tokio::test]
async fn scheduled_task_waits_then_starts_automatically() {
    let dir = tempfile::tempdir().unwrap();
    let payload = Arc::new(vec![0x5Au8; 2 * 1024 * 1024]);
    let (url, _server) = start_server(payload).await;
    let engine = engine_at(dir.path());

    // 计划 1.2 秒后开始。
    let at = chrono::Utc::now().timestamp_millis() + 1200;
    let opts = NewTaskOptions {
        scheduled_at: Some(at),
        ..Default::default()
    };
    let task = engine.add(TaskKind::Http, &url, opts).await.unwrap();
    let id = task.id.clone();

    // 建好即刻：暂停 + 有计划标记 + 零下载。
    let immediate = engine.get_task(&id).await.unwrap();
    assert_eq!(immediate.status, TaskStatus::Paused, "定时任务建好应暂停");
    assert_eq!(immediate.scheduled_at, Some(at), "应保留计划时间");
    assert_eq!(immediate.downloaded_bytes, 0, "到点前不应下载任何字节");

    // 等 0.6 秒：仍未到点，保持暂停。
    tokio::time::sleep(Duration::from_millis(600)).await;
    let mid = engine.get_task(&id).await.unwrap();
    assert_eq!(mid.status, TaskStatus::Paused, "未到点仍应暂停");
    assert_eq!(mid.scheduled_at, Some(at), "未到点标记仍在");

    // 再等 2 秒：已过计划时间，应自动启动并清空标记。
    tokio::time::sleep(Duration::from_millis(2000)).await;
    let after = engine.get_task(&id).await.unwrap();
    assert_eq!(after.scheduled_at, None, "到点后计划标记应清空");
    assert!(
        matches!(after.status, TaskStatus::Downloading | TaskStatus::Completed),
        "到点后应自动开始下载，实际状态：{:?}",
        after.status
    );
    assert!(after.downloaded_bytes > 0, "到点后应有下载进度");
}

#[tokio::test]
async fn past_schedule_or_manual_pause_cancels_scheduling() {
    let dir = tempfile::tempdir().unwrap();
    let payload = Arc::new(vec![0x5Au8; 256 * 1024]);
    let (url, _server) = start_server(payload).await;
    let engine = engine_at(dir.path());

    // 过去时间：视为立即下载，无计划标记。
    let past = chrono::Utc::now().timestamp_millis() - 10_000;
    let task = engine
        .add(TaskKind::Http, &url, NewTaskOptions { scheduled_at: Some(past), ..Default::default() })
        .await
        .unwrap();
    let immediate = engine.get_task(&task.id).await.unwrap();
    assert_eq!(immediate.scheduled_at, None, "过去时间不应产生计划标记");
    assert_ne!(immediate.status, TaskStatus::Paused, "过去时间应立即开始");

    // 未来时间 + 手动 pause：应取消定时。
    let at = chrono::Utc::now().timestamp_millis() + 10_000;
    let task2 = engine
        .add(TaskKind::Http, &url, NewTaskOptions { scheduled_at: Some(at), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(engine.get_task(&task2.id).await.unwrap().scheduled_at, Some(at));
    engine.pause(&task2.id).await;
    let paused = engine.get_task(&task2.id).await.unwrap();
    assert_eq!(paused.scheduled_at, None, "手动暂停应取消定时标记");
}
