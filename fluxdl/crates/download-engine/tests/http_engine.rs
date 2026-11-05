use fluxdl_engine::*;
use rand::RngCore;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

struct TestServer {
    pub url: String,
    _handle: tokio::task::JoinHandle<()>,
}

async fn start_server(payload: Arc<Vec<u8>>, support_ranges: bool) -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}/payload.bin");
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let payload = payload.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                {
                    let mut reader = BufReader::new(&mut socket);
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                            return;
                        }
                        if line == "\r\n" {
                            break;
                        }
                        head.push(line);
                    }
                }
                let mut range: Option<(u64, u64)> = None;
                for line in &head {
                    let lower = line.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("range:") {
                        let value = value.trim().trim_start_matches("bytes=");
                        if support_ranges {
                            if let Some((a, b)) = value.split_once('-') {
                                let start = a.parse::<u64>().unwrap_or(0);
                                let end = if b.is_empty() {
                                    payload.len() as u64 - 1
                                } else {
                                    b.parse::<u64>().unwrap_or(payload.len() as u64 - 1)
                                };
                                range = Some((start, end.min(payload.len() as u64 - 1)));
                            }
                        }
                    }
                }

                let total = payload.len() as u64;
                let (start, end, status) = match range {
                    Some((s, e)) if s < total => (s, e, "206 Partial Content"),
                    _ => (0, total.saturating_sub(1), "200 OK"),
                };
                if total == 0 {
                    let _ = socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                        .await;
                    return;
                }

                let mut header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"payload.bin\"\r\n",
                    end - start + 1
                );
                if support_ranges {
                    header.push_str("Accept-Ranges: bytes\r\n");
                    header.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
                }
                header.push_str("Connection: close\r\n\r\n");
                if socket.write_all(header.as_bytes()).await.is_err() {
                    return;
                }
                let mut pos = start as usize;
                while pos <= end as usize {
                    let stop = (pos + 32 * 1024).min(end as usize + 1);
                    if socket.write_all(&payload[pos..stop]).await.is_err() {
                        return;
                    }
                    pos = stop;
                }
                let _ = socket.flush().await;
            });
        }
    });
    TestServer {
        url,
        _handle: handle,
    }
}

fn test_options(dir: &std::path::Path) -> EngineOptions {
    EngineOptions {
        save_dir: dir.to_string_lossy().to_string(),
        max_active: 4,
        connections: 6,
        ..Default::default()
    }
}

async fn wait_until(
    engine: &Arc<Engine>,
    id: &str,
    timeout: Duration,
    mut done: impl FnMut(&TaskView) -> bool,
) -> TaskView {
    let start = Instant::now();
    loop {
        let view = engine.get_task(id).await.expect("task missing");
        if done(&view) {
            return view;
        }
        if start.elapsed() > timeout {
            panic!("timeout, last state: {view:?}");
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
}

async fn run_download_case(support_ranges: bool, size: usize) {
    let dir = tempfile::tempdir().unwrap();
    let mut payload = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut payload);
    let expected = payload.clone();
    let server = start_server(Arc::new(payload), support_ranges).await;
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(test_options(dir.path())).await;

    let task = engine
        .add(TaskKind::Http, &server.url, NewTaskOptions::default())
        .await
        .unwrap();
    let view = wait_until(&engine, &task.id, Duration::from_secs(30), |v| {
        v.status == TaskStatus::Completed || v.status == TaskStatus::Failed
    })
    .await;
    assert_eq!(view.status, TaskStatus::Completed, "{view:?}");
    let bytes = std::fs::read(dir.path().join("payload.bin")).unwrap();
    assert_eq!(bytes.len(), size);
    assert_eq!(bytes, expected);
    assert!(!dir.path().join("payload.bin.fluxdl-part").exists());
    if support_ranges {
        assert_eq!(view.connections, 6);
        assert_eq!(view.segments.len(), 6);
        assert!(view.segments.iter().all(|s| s.done));
    } else {
        assert!(!view.resumable);
        assert_eq!(view.connections, 1);
    }
}

#[tokio::test]
async fn downloads_with_range_connections() {
    run_download_case(true, 6 * 1024 * 1024).await;
}

#[tokio::test]
async fn downloads_without_range_support() {
    run_download_case(false, 1024 * 1024).await;
}

#[tokio::test]
async fn pause_then_resume_keeps_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let mut payload = vec![0u8; 2 * 1024 * 1024];
    rand::thread_rng().fill_bytes(&mut payload);
    let expected = payload.clone();
    let server = start_server(Arc::new(payload), true).await;
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    let mut options = test_options(dir.path());
    options.connections = 4;
    engine.set_options(options).await;

    let mut task_options = NewTaskOptions::default();
    task_options.speed_limit = Some(500 * 1024);
    let task = engine
        .add(TaskKind::Http, &server.url, task_options)
        .await
        .unwrap();

    let partial = wait_until(&engine, &task.id, Duration::from_secs(20), |v| {
        v.downloaded_bytes > 350 * 1024 || v.status == TaskStatus::Completed
    })
    .await;
    assert_eq!(partial.status, TaskStatus::Downloading, "{partial:?}");

    engine.pause(&task.id).await;
    let paused = wait_until(&engine, &task.id, Duration::from_secs(5), |v| {
        v.status == TaskStatus::Paused
    })
    .await;
    assert!(paused.downloaded_bytes > 100 * 1024, "{paused:?}");
    assert!(dir.path().join("payload.bin.fluxdl-part").exists());

    engine.set_speed_limit(&task.id, None).await;
    engine.resume(&task.id).await;
    let finished = wait_until(&engine, &task.id, Duration::from_secs(30), |v| {
        v.status == TaskStatus::Completed || v.status == TaskStatus::Failed
    })
    .await;
    assert_eq!(finished.status, TaskStatus::Completed, "{finished:?}");
    let bytes = std::fs::read(dir.path().join("payload.bin")).unwrap();
    assert_eq!(bytes, expected);
}

#[tokio::test]
async fn persists_and_restores_paused_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let mut payload = vec![0u8; 4 * 1024 * 1024];
    rand::thread_rng().fill_bytes(&mut payload);
    let server = start_server(Arc::new(payload), true).await;
    let store_path = dir.path().join("tasks.json");
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(store_path.clone(), tx);
    engine.set_options(test_options(dir.path())).await;
    let mut task_options = NewTaskOptions::default();
    task_options.speed_limit = Some(400 * 1024);
    let task = engine
        .add(TaskKind::Http, &server.url, task_options)
        .await
        .unwrap();
    let before_pause = wait_until(&engine, &task.id, Duration::from_secs(20), |v| {
        v.downloaded_bytes > 250 * 1024 || v.status == TaskStatus::Failed
    })
    .await;
    assert_eq!(before_pause.status, TaskStatus::Downloading);
    engine.pause(&task.id).await;
    engine.save().await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();
    let restored = Engine::new(store_path, tx2);
    let views = restored.tasks().await;
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].status, TaskStatus::Paused);
    assert!(views[0].segments.len() > 1);
    assert!(views[0].downloaded_bytes > 0);
}
