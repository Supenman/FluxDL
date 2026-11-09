//! 手工联调程序：直接用真实 yt-dlp + 真实 aria2c 跑一次媒体下载，
//! 把引擎收到的每一行协议输出打印出来，用来肉眼确认真实环境下的进度刷新。
//!
//! 用法（Linux / macOS）：
//! ```bash
//! cargo run -p fluxdl-engine --example media_probe -- <URL> <输出目录> <yt-dlp 路径> <aria2c 路径>
//! ```
//! Windows 下参数相同，路径换成 .exe 即可。
//!
//! 这个 example 不参与打包，只为「改动 aria2 相关代码后做一次真机验证」而存在。

use std::sync::Arc;
use std::time::{Duration, Instant};

use fluxdl_engine::*;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let url = args.next().expect("缺少 URL");
    let dir = std::path::PathBuf::from(args.next().expect("缺少输出目录"));
    let yt = args.next().expect("缺少 yt-dlp 路径");
    let aria2 = args.next();

    std::fs::create_dir_all(&dir).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = Engine::new(dir.join("probe-tasks.json"), tx.clone());

    let mut options = engine.options();
    options.save_dir = dir.to_string_lossy().to_string();
    options.yt_dlp_path = yt;
    options.aria2_path = aria2;
    engine.set_options(options).await;

    // 事件旁观者：把进度行按到达时间打出来，直观看到「是否有实时刷新」。
    tokio::spawn(async move {
        let start = Instant::now();
        let mut last = Instant::now() - Duration::from_secs(10);
        while let Some(ev) = rx.recv().await {
            match ev {
                EngineEvent::Task(v) => {
                    // 与引擎内部节流一致：每 1 秒打一行，避免刷屏
                    let now = Instant::now();
                    if (v.speed_bps > 0 || v.downloaded_bytes > 0)
                        && (last.elapsed() >= Duration::from_secs(1) || !v.status.is_active())
                    {
                        last = now;
                        eprintln!(
                            "[{:>6.2}s] 进度 {:>10} / {:>10}  {:>10} B/s  状态={:?}",
                            start.elapsed().as_secs_f64(),
                            v.downloaded_bytes,
                            v.total_bytes,
                            v.speed_bps,
                            v.status
                        );
                    }
                }
                EngineEvent::Log(l) => eprintln!("[LOG] {}", l.message),
                _ => {}
            }
        }
    });

    let task = engine
        .add(
            TaskKind::Media,
            &url,
            NewTaskOptions {
                aria2: true,
                ..Default::default()
            },
        )
        .await
        .expect("创建任务失败");
    println!("任务已创建：{}", task.id);

    let start = Instant::now();
    loop {
        let view = engine.get_task(&task.id).await.expect("任务消失");
        if matches!(view.status, TaskStatus::Completed | TaskStatus::Failed) {
            println!(
                "最终状态：{:?}  用时 {:.2}s  文件：{}  大小：{}",
                view.status,
                start.elapsed().as_secs_f64(),
                view.save_path,
                view.downloaded_bytes
            );
            if let Some(err) = view.error {
                println!("错误：{err}");
                std::process::exit(1);
            }
            break;
        }
        if start.elapsed() > Duration::from_secs(600) {
            println!("超时");
            std::process::exit(1);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = Arc::strong_count(&engine);
}
