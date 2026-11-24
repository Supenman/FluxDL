//! 下载审核闸门端到端：任何来源的新任务都必须等用户批准才会启动。
//!
//! 这是防「网页扩展静默批量灌入几十条任务」的核心保证：
//! - 新建任务一律 pendingApproval=true 且状态 Paused，不下载；
//! - resume / resume_all / retry / 定时触发都绕不过闸门；
//! - 只有 approve / approve_all 能把标记清掉并启动。

use std::path::PathBuf;

use fluxdl_engine::{Engine, EngineEvent, NewTaskOptions, TaskKind, TaskStatus};
use tokio::sync::mpsc;

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "fluxdl-approval-{name}-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn engine(dir: &PathBuf) -> (std::sync::mpsc::Receiver<EngineEvent>, std::sync::Arc<Engine>) {
    // Engine 的事件通道用 tokio unbounded；这里只需要能丢弃事件。
    let (tx, _rx) = mpsc::unbounded_channel();
    let eng = Engine::new(dir.join("tasks.json"), tx);
    // 返回一个同步 receiver 占位，实际断言走 get_task 轮询。
    let (_stx, srx) = std::sync::mpsc::channel();
    (srx, eng)
}

#[tokio::test]
async fn new_task_is_pending_and_never_starts_on_its_own() {
    let dir = workdir("pending");
    let (_rx, eng) = engine(&dir);
    let t = eng
        .add(
            TaskKind::Http,
            "https://example.com/file.bin",
            NewTaskOptions {
                save_dir: Some(dir.to_string_lossy().to_string()),
                require_approval: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    assert!(t.pending_approval, "新任务必须标记为待审核");
    assert_eq!(t.status, TaskStatus::Paused, "新任务必须暂停，不能直接下载");

    // 即使过了几个 tick 周期，任务仍未被启动（没有 downloader 进程、状态不变）。
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    let after = eng.get_task(&t.id).await.unwrap();
    assert_eq!(after.status, TaskStatus::Paused);
    assert!(after.pending_approval);
    assert_eq!(after.downloaded_bytes, 0);
}

#[tokio::test]
async fn resume_and_resume_all_cannot_bypass_the_gate() {
    let dir = workdir("bypass");
    let (_rx, eng) = engine(&dir);
    let t = eng
        .add(
            TaskKind::Http,
            "https://example.com/a.bin",
            NewTaskOptions {
                save_dir: Some(dir.to_string_lossy().to_string()),
                require_approval: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    eng.resume(&t.id).await;
    let after_resume = eng.get_task(&t.id).await.unwrap();
    assert!(after_resume.pending_approval, "resume 不能清掉待审核标记");
    assert_eq!(after_resume.status, TaskStatus::Paused);

    eng.resume_all().await;
    let after_all = eng.get_task(&t.id).await.unwrap();
    assert!(after_all.pending_approval, "resume_all 不能放行待审核任务");
    assert_eq!(after_all.status, TaskStatus::Paused);
}

#[tokio::test]
async fn approve_clears_flag_and_allows_start() {
    let dir = workdir("approve");
    let (_rx, eng) = engine(&dir);
    let t = eng
        .add(
            TaskKind::Http,
            "https://127.0.0.1:1/no-server.bin",
            NewTaskOptions {
                save_dir: Some(dir.to_string_lossy().to_string()),
                require_approval: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    eng.approve(&t.id).await;
    let approved = eng.get_task(&t.id).await.unwrap();
    assert!(!approved.pending_approval, "批准必须清掉待审核标记");
    // 连接一个不存在的地址会失败，但状态一定不再是 Paused——说明闸门已放行。
    assert_ne!(approved.status, TaskStatus::Paused, "批准后任务应离开暂停态开始尝试");
}

#[tokio::test]
async fn approve_all_clears_every_pending_task() {
    let dir = workdir("approve-all");
    let (_rx, eng) = engine(&dir);
    for i in 0..3 {
        eng.add(
            TaskKind::Http,
            &format!("https://127.0.0.1:1/f{i}.bin"),
            NewTaskOptions {
                save_dir: Some(dir.to_string_lossy().to_string()),
                require_approval: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    eng.approve_all().await;
    let tasks = eng.tasks().await;
    assert_eq!(tasks.len(), 3);
    assert!(
        tasks.iter().all(|t| !t.pending_approval),
        "approve_all 必须清掉全部待审核标记"
    );
}
