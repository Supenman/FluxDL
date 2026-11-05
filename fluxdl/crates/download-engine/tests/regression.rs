//! 针对代码审查中发现的高风险问题写的复现测试。
//! 这些测试描述的是「期望的正确行为」；在当前实现上运行会出现失败，
//! 说明问题真实存在（fail = 缺陷复现成功）。
//!
//! 运行方式：
//!   cargo test --test regression -- --nocapture
//! 单独运行某个：
//!   cargo test --test regression p0_2 -- --nocapture

use fluxdl_engine::*;
use rand::RngCore;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

// ---------------------------------------------------------------- 测试服务器

struct TestServer {
    pub url: String,
    _handle: tokio::task::JoinHandle<()>,
}

/// 起一个可控的 HTTP 服务器：支持 Range，payload 固定。
async fn start_server(payload: Arc<Vec<u8>>) -> TestServer {
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
                let total = payload.len() as u64;
                let mut range: Option<(u64, u64)> = None;
                for line in &head {
                    let lower = line.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("range:") {
                        let value = value.trim().trim_start_matches("bytes=");
                        if let Some((a, b)) = value.split_once('-') {
                            let start = a.parse::<u64>().unwrap_or(0);
                            let end = if b.is_empty() {
                                total - 1
                            } else {
                                b.parse::<u64>().unwrap_or(total - 1)
                            };
                            range = Some((start, end.min(total - 1)));
                        }
                    }
                }
                let (start, end, status) = match range {
                    Some((s, e)) if s < total => (s, e, "206 Partial Content"),
                    _ => (0, total.saturating_sub(1), "200 OK"),
                };
                let mut header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\n",
                    end - start + 1
                );
                header.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
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
        max_active: 8,
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
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ------------------------------------------------------- P0-2：续传时不校验磁盘

/// 复现：`.fluxdl-part` 丢失后继续下载，产出「长度正确但内容一半是 0」的文件。
///
/// 场景：下载暂停 → 用户/清理工具删掉了 .fluxdl-part → 恢复下载。
/// 期望：检测到 part 缺失，重新完整下载，内容与源文件一致。
/// 当前实现：trust tasks.json 里的分段进度，跳过「已完成」分段，把空文件 set_len 成完整长度。
#[tokio::test]
async fn p0_2_resume_after_part_deleted_must_not_corrupt() {
    let dir = tempfile::tempdir().unwrap();
    let size = 4 * 1024 * 1024;
    let mut payload = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut payload);
    let expected = payload.clone();
    let server = start_server(Arc::new(payload)).await;

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(test_options(dir.path())).await;

    // 限速以保证能稳定地暂停在中途
    let mut opts = NewTaskOptions::default();
    opts.speed_limit = Some(600 * 1024);
    let task = engine.add(TaskKind::Http, &server.url, opts).await.unwrap();

    wait_until(&engine, &task.id, Duration::from_secs(20), |v| {
        v.downloaded_bytes > 500 * 1024
    })
    .await;
    engine.pause(&task.id).await;
    let paused = wait_until(&engine, &task.id, Duration::from_secs(5), |v| {
        v.status == TaskStatus::Paused
    })
    .await;
    eprintln!("[P0-2] 暂停时已下载 {} 字节", paused.downloaded_bytes);

    let part = dir.path().join("payload.bin.fluxdl-part");
    assert!(part.exists(), "暂停后应存在 part 文件");
    std::fs::remove_file(&part).expect("删除 part 文件（模拟清理/丢失）");

    engine.set_speed_limit(&task.id, None).await;
    engine.resume(&task.id).await;
    let finished = wait_until(&engine, &task.id, Duration::from_secs(40), |v| {
        v.status == TaskStatus::Completed || v.status == TaskStatus::Failed
    })
    .await;
    assert_eq!(finished.status, TaskStatus::Completed, "{finished:?}");

    let bytes = std::fs::read(dir.path().join("payload.bin")).unwrap();
    assert_eq!(bytes.len(), size, "长度应为 {}", size);
    let zeros = bytes.iter().filter(|b| **b == 0).count();
    eprintln!("[P0-2] 输出文件中 0 字节数量 = {zeros} / {size}");
    assert_eq!(bytes, expected, "【缺陷复现】续传后文件内容与源不一致（存在被补零的空洞）");
}

// --------------------------------------------------- P0-1：同名目标路径未占位

/// 复现：两个任务并发写同一个 `.fluxdl-part`。
///
/// 场景：连续两次 add 同一/同名 URL，`unique_path` 只看最终文件是否存在，
/// 两次都拿到 `payload.bin`，于是共享同一个 part 文件。
/// 期望：两个任务拿到不同的目标路径。
#[tokio::test]
async fn p0_1_duplicate_concurrent_tasks_must_not_share_part_file() {
    let dir = tempfile::tempdir().unwrap();
    let size = 3 * 1024 * 1024;
    let mut payload = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut payload);
    let server = start_server(Arc::new(payload)).await;

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(test_options(dir.path())).await;

    let a = engine
        .add(TaskKind::Http, &server.url, NewTaskOptions::default())
        .await
        .unwrap();
    // 立刻再加一个：此时 a 的最终文件还不存在，part 也还没创建
    let b = engine
        .add(TaskKind::Http, &server.url, NewTaskOptions::default())
        .await
        .unwrap();

    eprintln!("[P0-1] A save_path = {}", a.save_path);
    eprintln!("[P0-1] B save_path = {}", b.save_path);

    wait_until(&engine, &a.id, Duration::from_secs(30), |v| {
        v.status == TaskStatus::Completed || v.status == TaskStatus::Failed
    })
    .await;
    wait_until(&engine, &b.id, Duration::from_secs(30), |v| {
        v.status == TaskStatus::Completed || v.status == TaskStatus::Failed
    })
    .await;

    assert_ne!(
        a.save_path, b.save_path,
        "【缺陷复现】两个并发任务被分配到同一个目标路径，会共用 .fluxdl-part 并交错写入"
    );
}

// ------------------------------------------- P1-4：删除任务不清理 part 文件

/// 复现：删除（含删除文件）一个暂停中的任务后，`.fluxdl-part` 仍留在磁盘上。
///
/// 期望：delete_file=true 时应同时清理未完成的 part 文件。
#[tokio::test]
async fn p1_4_remove_task_must_clean_part_file() {
    let dir = tempfile::tempdir().unwrap();
    let size = 4 * 1024 * 1024;
    let mut payload = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut payload);
    let server = start_server(Arc::new(payload)).await;

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(test_options(dir.path())).await;

    let mut opts = NewTaskOptions::default();
    opts.speed_limit = Some(500 * 1024);
    let task = engine.add(TaskKind::Http, &server.url, opts).await.unwrap();
    wait_until(&engine, &task.id, Duration::from_secs(20), |v| {
        v.downloaded_bytes > 400 * 1024
    })
    .await;
    engine.pause(&task.id).await;
    wait_until(&engine, &task.id, Duration::from_secs(5), |v| {
        v.status == TaskStatus::Paused
    })
    .await;

    let part = dir.path().join("payload.bin.fluxdl-part");
    assert!(part.exists(), "暂停后应存在 part 文件");

    engine.remove(&task.id, true).await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    assert!(
        !part.exists(),
        "【缺陷复现】删除任务（delete_file=true）后 .fluxdl-part 仍残留，占用磁盘"
    );
}

// ---------------------------------------- 辅助：确认「正常续传」仍然工作（反例保护）

/// 正常续传（part 仍在）必须一致——用于确保 P0-2 的修复不要把正常路径也一起废掉。
#[tokio::test]
async fn baseline_resume_with_part_present_is_correct() {
    let dir = tempfile::tempdir().unwrap();
    let size = 2 * 1024 * 1024;
    let mut payload = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut payload);
    let expected = payload.clone();
    let server = start_server(Arc::new(payload)).await;

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(test_options(dir.path())).await;

    let mut opts = NewTaskOptions::default();
    opts.speed_limit = Some(500 * 1024);
    let task = engine.add(TaskKind::Http, &server.url, opts).await.unwrap();
    wait_until(&engine, &task.id, Duration::from_secs(20), |v| {
        v.downloaded_bytes > 300 * 1024
    })
    .await;
    engine.pause(&task.id).await;
    wait_until(&engine, &task.id, Duration::from_secs(5), |v| {
        v.status == TaskStatus::Paused
    })
    .await;

    engine.set_speed_limit(&task.id, None).await;
    engine.resume(&task.id).await;
    wait_until(&engine, &task.id, Duration::from_secs(30), |v| {
        v.status == TaskStatus::Completed || v.status == TaskStatus::Failed
    })
    .await;

    let bytes = std::fs::read(dir.path().join("payload.bin")).unwrap();
    assert_eq!(bytes, expected, "正常续传（part 存在）必须内容一致");
}

// ------------------------------------ P0-1（重启路径）：占位必须在 hydrate 时恢复

/// 复现：重启后路径占位丢失，新任务与已持久化的任务撞到同一个目标。
///
/// 场景：任务 A 暂停 → 关掉应用 → 用户清理工具把 `.fluxdl-part` 删了 →
///       重启后重新添加同名链接。此时 A 的最终文件和 part 都不在磁盘上，
///       若 `reserved` 没有从 tasks.json 恢复，B 会拿到和 A 相同的 save_path。
/// 期望：B 必须避开 A 已占用的路径。
#[tokio::test]
async fn p0_1b_reserved_paths_must_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let size = 4 * 1024 * 1024;
    let mut payload = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut payload);
    let server = start_server(Arc::new(payload)).await;
    let store = dir.path().join("tasks.json");

    // 第一段生命周期：建任务 A 并暂停
    let a_path;
    {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let engine = Engine::new(store.clone(), tx);
        engine.set_options(test_options(dir.path())).await;
        let mut opts = NewTaskOptions::default();
        opts.speed_limit = Some(600 * 1024);
        let a = engine.add(TaskKind::Http, &server.url, opts).await.unwrap();
        a_path = a.save_path.clone();
        wait_until(&engine, &a.id, Duration::from_secs(20), |v| {
            v.downloaded_bytes > 400 * 1024
        })
        .await;
        engine.pause(&a.id).await;
        wait_until(&engine, &a.id, Duration::from_secs(5), |v| {
            v.status == TaskStatus::Paused
        })
        .await;
    } // engine 在这里被释放，等于应用退出

    // 模拟「part 被外部清理」：此时磁盘上既没有最终文件，也没有 part
    let part = dir.path().join("payload.bin.fluxdl-part");
    if part.exists() {
        std::fs::remove_file(&part).unwrap();
    }
    assert!(!dir.path().join("payload.bin").exists());
    assert!(!part.exists());

    // 第二段生命周期：重启后加同名任务
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(store, tx);
    engine.set_options(test_options(dir.path())).await;
    let b = engine
        .add(TaskKind::Http, &server.url, NewTaskOptions::default())
        .await
        .unwrap();

    eprintln!("[P0-1b] 重启前任务 A save_path = {a_path}");
    eprintln!("[P0-1b] 重启后任务 B save_path = {}", b.save_path);
    assert_ne!(
        a_path, b.save_path,
        "【缺陷复现】重启后占位丢失，新任务与已恢复任务共用同一目标路径"
    );
}

// ----------------------------- P0-1（终态释放）：完成的任务不应长期占用原名

/// 复现：任务完成后路径占位不释放，用户删掉文件重下同名时被挤成「file (1)」。
///
/// 期望：任务完成（文件已落盘）后释放占位；用户删除文件再下载应重新用回原名。
#[tokio::test]
async fn p0_1c_completed_task_must_release_reserved_path() {
    let dir = tempfile::tempdir().unwrap();
    let size = 512 * 1024;
    let mut payload = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut payload);
    let server = start_server(Arc::new(payload)).await;

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(test_options(dir.path())).await;

    let a = engine
        .add(TaskKind::Http, &server.url, NewTaskOptions::default())
        .await
        .unwrap();
    wait_until(&engine, &a.id, Duration::from_secs(30), |v| {
        v.status == TaskStatus::Completed
    })
    .await;

    // 用户把下好的文件删了（换内容/腾空间），然后重新下同一份
    let target = dir.path().join("payload.bin");
    assert!(target.exists(), "任务完成后应有最终文件");
    std::fs::remove_file(&target).unwrap();

    let b = engine
        .add(TaskKind::Http, &server.url, NewTaskOptions::default())
        .await
        .unwrap();
    eprintln!("[P0-1c] 删除文件后重下，B save_path = {}", b.save_path);
    assert_eq!(
        b.save_path, a.save_path,
        "【缺陷复现】完成任务未释放占位，重下同名文件被重命名"
    );
}

// ------------------------------------------- P1-5：并发 save 写竞争

/// 复现：`save()` 无互斥，多个调用同时写固定的 `tasks.json.tmp` 并抢 rename，
/// 会出现「保存失败」日志甚至损坏的任务列表。
#[tokio::test]
async fn p1_5_concurrent_save_must_not_corrupt_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("tasks.json");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(store.clone(), tx);
    engine.set_options(test_options(dir.path())).await;

    // 造 20 个立即失败的任务（端口 1 无人监听），让持久化内容有一定体积
    for i in 0..20 {
        let url = format!("http://127.0.0.1:1/file{i}.bin");
        engine
            .add(TaskKind::Http, &url, NewTaskOptions::default())
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    // 并发 32 次 save
    let mut handles = Vec::new();
    for _ in 0..32 {
        let e = engine.clone();
        handles.push(tokio::spawn(async move { e.save().await }));
    }
    for h in handles {
        h.await.unwrap();
    }

    let mut errors = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let EngineEvent::Log(line) = ev {
            if line.message.contains("任务列表保存失败") {
                errors.push(line.message);
            }
        }
    }

    let raw = std::fs::read_to_string(&store).unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).expect("【缺陷复现】并发 save 后 tasks.json 已损坏");
    let n = parsed["tasks"].as_array().map(|a| a.len()).unwrap_or(0);

    eprintln!("[P1-5] 保存失败日志 {} 条，tasks.json 中任务数 {n}", errors.len());
    assert!(
        errors.is_empty(),
        "【缺陷复现】并发 save 出现写竞争：{errors:?}"
    );
    assert_eq!(n, 20, "任务数量应与实际一致");
}

// ------------------------------------------- probe：首次失败即放弃，不重试

/// 前 `fail_first` 个请求返回 500，之后正常。
async fn start_server_flaky(payload: Arc<Vec<u8>>, fail_first: usize) -> TestServer {
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}/payload.bin");
    let seen = Arc::new(AtomicUsize::new(0));
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            let n = seen.fetch_add(1, AtomicOrdering::SeqCst);
            let payload = payload.clone();
            tokio::spawn(async move {
                if n < fail_first {
                    let _ = socket
                        .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                    return;
                }
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
                let mut range: Option<(u64, u64)> = None;
                for line in &head {
                    let lower = line.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("range:") {
                        let v = v.trim().trim_start_matches("bytes=");
                        if let Some((a, b)) = v.split_once('-') {
                            let start = a.parse::<u64>().unwrap_or(0);
                            let end = if b.is_empty() { total - 1 } else { b.parse::<u64>().unwrap_or(total - 1) };
                            range = Some((start, end.min(total - 1)));
                        }
                    }
                }
                let (start, end, status) = match range {
                    Some((s, e)) if s < total => (s, e, "206 Partial Content"),
                    _ => (0, total.saturating_sub(1), "200 OK"),
                };
                let mut header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\n",
                    end - start + 1
                );
                header.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\nConnection: close\r\n\r\n"));
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
    TestServer { url, _handle: handle }
}

/// 复现：probe 只发一次 `RANGE: bytes=0-0`，遇到临时 5xx 直接把任务判失败。
/// 期望：与分段下载一致，网络/服务端临时错误应重试后再放弃。
#[tokio::test]
async fn p1_probe_should_retry_transient_errors() {
    let dir = tempfile::tempdir().unwrap();
    let size = 512 * 1024;
    let mut payload = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut payload);
    let expected = payload.clone();
    let server = start_server_flaky(Arc::new(payload), 2).await;

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(test_options(dir.path())).await;

    let task = engine
        .add(TaskKind::Http, &server.url, NewTaskOptions::default())
        .await
        .unwrap();
    let finished = wait_until(&engine, &task.id, Duration::from_secs(40), |v| {
        v.status == TaskStatus::Completed || v.status == TaskStatus::Failed
    })
    .await;

    eprintln!("[probe] 最终状态 = {:?}, error = {:?}", finished.status, finished.error);
    assert_eq!(
        finished.status,
        TaskStatus::Completed,
        "【缺陷复现】probe 遇到临时错误未重试，任务直接失败"
    );
    let bytes = std::fs::read(dir.path().join("payload.bin")).unwrap();
    assert_eq!(bytes, expected, "重试后下载内容应完整");
}

// ------------------------------------------- P1-6：并发 resume 的防御性保护

/// 并发 resume 不应破坏暂停语义。
/// 说明：`spawn_runner` 检查与置位之间的窗口很窄，这个用例是**回归保护**，
/// 不保证在旧代码上稳定失败；真正的修复验证靠代码审查 + 下面的状态断言。
#[tokio::test]
async fn p1_6_concurrent_resume_keeps_pause_effective() {
    let dir = tempfile::tempdir().unwrap();
    let size = 4 * 1024 * 1024;
    let mut payload = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut payload);
    let server = start_server(Arc::new(payload)).await;

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.path().join("tasks.json"), tx);
    engine.set_options(test_options(dir.path())).await;

    let opts = NewTaskOptions {
        speed_limit: Some(300 * 1024),
        ..Default::default()
    };
    let task = engine.add(TaskKind::Http, &server.url, opts).await.unwrap();
    wait_until(&engine, &task.id, Duration::from_secs(20), |v| {
        v.downloaded_bytes > 200 * 1024
    })
    .await;
    engine.pause(&task.id).await;
    wait_until(&engine, &task.id, Duration::from_secs(5), |v| {
        v.status == TaskStatus::Paused
    })
    .await;

    let mut handles = Vec::new();
    for _ in 0..16 {
        let e = engine.clone();
        let id = task.id.clone();
        handles.push(tokio::spawn(async move { e.resume(&id).await }));
    }
    for h in handles { h.await.unwrap(); }

    wait_until(&engine, &task.id, Duration::from_secs(20), |v| {
        v.downloaded_bytes > 450 * 1024
    })
    .await;
    engine.pause(&task.id).await;
    let paused = wait_until(&engine, &task.id, Duration::from_secs(5), |v| {
        v.status == TaskStatus::Paused
    })
    .await;
    let at_pause = paused.downloaded_bytes;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let after = engine.get_task(&task.id).await.unwrap();
    eprintln!("[P1-6] 暂停时 {at_pause} 字节，1.2s 后 {} 字节", after.downloaded_bytes);
    assert_eq!(
        after.downloaded_bytes, at_pause,
        "【缺陷复现】暂停后仍在下载，取消令牌被并发 resume 覆盖"
    );
}
