//! v0.3.6 真机截图问题的功能回归测试。
//!
//! 覆盖：
//!   1. 复制快手 / 抖音**页面链接**不再建成必然失败的 Media 任务
//!      （Engine::add 提前拒绝，且不落任何任务 / 工作目录）
//!   2. yt-dlp 失败时下载目录不再残留 `fluxdl-<id>` 文件夹（WorkDirGuard）
//!   3. 成功下载后产物仍发布回用户下载目录，独占目录同样不残留
//!   4. CDN 容器直链与正常详情页不被提前拦截误伤
//!
//! 扩展侧「整页解析不可用改走嗅探直链」由
//! `scripts/check_extension_contract.cjs` 实跑覆盖。
//! 全部使用假 yt-dlp，不依赖外网 / 真实解析器。

use fluxdl_engine::*;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn engine(dir: &Path) -> Arc<Engine> {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    Engine::new(dir.join("tasks.json"), tx)
}

async fn wait_done(engine: &Arc<Engine>, id: &str, secs: u64) -> TaskView {
    let start = Instant::now();
    loop {
        let view = engine.get_task(id).await.expect("task missing");
        if matches!(view.status, TaskStatus::Completed | TaskStatus::Failed) {
            return view;
        }
        if start.elapsed() > Duration::from_secs(secs) {
            panic!("timeout，最后状态：{view:?}");
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

fn write_exe(dir: &Path, stem: &str, body: &str) -> PathBuf {
    #[cfg(windows)]
    {
        let path = dir.join(format!("{stem}.cmd"));
        std::fs::write(&path, body).unwrap();
        path
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(stem);
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        let mut perm = std::fs::metadata(&path).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&path, perm).unwrap();
        path
    }
}

async fn engine_with_tools(dir: &Path, yt_body: &str) -> Arc<Engine> {
    let tools = dir.join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let yt = write_exe(&tools, "yt-dlp", yt_body);
    let e = engine(dir);
    let mut options = e.options();
    options.save_dir = dir.to_string_lossy().to_string();
    options.yt_dlp_path = yt.to_string_lossy().to_string();
    e.set_options(options).await;
    e
}

fn leftover_work_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| {
            e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && e.file_name().to_string_lossy().starts_with("fluxdl-")
        })
        .map(|e| e.path())
        .collect()
}

/// 问题 1/2 的引擎侧：真机截图里用户粘贴的快手 / 抖音页面 URL 会被建成
/// 失败任务，报 Unsupported URL / Fresh cookies。0.3.6 在 add() 阶段直接拒绝，
/// 因此既不会有失败任务，也不会在下载目录留下 fluxdl-<id> 文件夹。
#[tokio::test]
async fn unparsable_media_pages_are_rejected_before_creating_tasks() {
    let dir = tempfile::tempdir().unwrap();
    // 故意不配置 yt-dlp：若真的创建了任务，会立刻失败并留下目录。
    let e = engine(dir.path());
    for url in [
        "https://www.kuaishou.com/new-reco",
        "https://www.douyin.com/video/7702008165390421263",
        "https://www.douyin.com/jingxuan?modal_id=7702008165390421263",
    ] {
        let err = e
            .add(TaskKind::Media, url, NewTaskOptions::default())
            .await
            .expect_err("页面链接应被提前拒绝");
        assert!(
            err.to_string().contains("本页资源") || err.to_string().contains("直链"),
            "{url} 的提示必须给出可操作路径，实际：{err}"
        );
    }
    assert!(e.tasks().await.is_empty(), "被拒绝的链接不得创建任务");
    assert!(
        leftover_work_dirs(dir.path()).is_empty(),
        "被拒绝的链接不得创建工作目录"
    );
}

/// 问题 3：yt-dlp 失败时目录连同 .part / .m4s 必须被清理。
/// 0.3.5 只在「成功发布产物」一处 remove_dir_all，失败直接 return，
/// 用户每失败一次下载目录就多一个 fluxdl-<id> 文件夹（真机截图已复现）。
#[tokio::test]
async fn failed_media_task_leaves_no_work_dir() {
    let dir = tempfile::tempdir().unwrap();
    let body = r#"outdir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
done
if [ -z "$outdir" ]; then
  echo "Probe Title"
  exit 0
fi
echo "partial" > "$outdir/out.mp4.part"
echo "seg" > "$outdir/seg-1.m4s"
echo "ERROR: Unsupported URL" >&2
exit 1
"#;
    let e = engine_with_tools(dir.path(), body).await;
    let view = e
        .add(
            TaskKind::Media,
            "https://www.bilibili.com/video/BV1xx",
            NewTaskOptions::default(),
        )
        .await
        .unwrap();
    let done = wait_done(&e, &view.id, 20).await;
    assert_eq!(done.status, TaskStatus::Failed, "假 yt-dlp 退出 1 应判失败：{done:?}");
    assert!(done.error.is_some(), "失败任务应带错误信息");

    let short: String = view.id.chars().take(8).collect();
    let work = dir.path().join(format!("fluxdl-{short}"));
    assert!(!work.exists(), "失败任务不得留下工作目录：{}", work.display());
    assert!(
        leftover_work_dirs(dir.path()).is_empty(),
        "下载目录不应残留任何 fluxdl-* 文件夹：{:?}",
        leftover_work_dirs(dir.path())
    );
}

/// 问题 3 的另一半：成功下载后产物必须发布回用户下载目录，
/// 且独占目录同样不能残留（成功路径以前手动删，现在由 guard 统一兜底）。
#[tokio::test]
async fn completed_media_task_also_cleans_up_work_dir() {
    let dir = tempfile::tempdir().unwrap();
    let body = r#"outdir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
done
if [ -z "$outdir" ]; then
  echo "Probe Title"
  exit 0
fi
echo "partial" > "$outdir/out.mp4.part"
echo "payload" > "$outdir/real-video.mp4"
echo "FLUXDONE|$outdir/real-video.mp4"
"#;
    let e = engine_with_tools(dir.path(), body).await;
    let view = e
        .add(
            TaskKind::Media,
            "https://www.bilibili.com/video/BV1xx",
            NewTaskOptions::default(),
        )
        .await
        .unwrap();
    let done = wait_done(&e, &view.id, 20).await;
    assert_eq!(done.status, TaskStatus::Completed, "任务应成功：{:?}", done.error);
    assert_eq!(done.filename, "real-video.mp4");
    assert_eq!(PathBuf::from(&done.save_path).parent(), Some(dir.path()));
    assert!(PathBuf::from(&done.save_path).exists());
    assert!(
        leftover_work_dirs(dir.path()).is_empty(),
        "成功任务也不得残留工作目录"
    );
}

/// CDN 容器直链不受 0.3.6 页面拦截影响，仍能正常建任务并下载。
/// （Rust looks_like_media 会把它短路成 HTTP 普通下载；引擎 add 层不拦。）
#[tokio::test]
async fn direct_container_url_is_not_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let body = r#"outdir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
done
if [ -z "$outdir" ]; then echo "Probe"; exit 0; fi
echo "payload" > "$outdir/direct.mp4"
echo "FLUXDONE|$outdir/direct.mp4"
"#;
    let e = engine_with_tools(dir.path(), body).await;
    let view = e
        .add(
            TaskKind::Media,
            "https://v2.kuaishou.com/abc.mp4",
            NewTaskOptions::default(),
        )
        .await
        .expect("CDN 容器直链不得被页面拦截误伤");
    let done = wait_done(&e, &view.id, 20).await;
    assert_eq!(done.status, TaskStatus::Completed, "{:?}", done.error);
}
