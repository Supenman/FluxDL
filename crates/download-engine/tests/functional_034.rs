//! v0.3.4 功能缺口回归测试。
//!
//! 0.3.3 的 `tests/media_aria2.rs` 全部用 `example.com` 直链伪造 yt-dlp / aria2，
//! 没有覆盖真实分片站点、非 ASCII 标题、`after_move` 缺失、并发同目录、
//! 旧版 tasks.json 缺字段这些用户实际会踩到的路径 —— 所以 0.3.3 的修复
//! 「测了但没保护住」。这里逐条补上，全部不依赖外网、不依赖真实 yt-dlp。
//!
//! 覆盖清单（对应 `功能复查-v0.3.3.md` 第七节第 4 条）：
//!   1. 非 B 站分片站点不走 aria2           -> fragmented_sites_never_auto_enable_aria2
//!   2. 非 ASCII 合法标题不被丢             -> non_ascii_title_is_backfilled（链路级）
//!      （纯函数 `looks_mojibake` 的样本回归在 media.rs 单测里）
//!   3. after_move / FLUXDONE 缺失           -> missing_after_move_still_publishes_output
//!   4. 并发同目录不串台                     -> concurrent_tasks_do_not_cross_claim_output
//!   5. 旧版 tasks.json 缺字段               -> legacy_tasks_json_missing_fields_is_recovered
//!   6. 扩展 payload 字段契约               -> src-tauri/src/lib.rs 的 contract_tests
//!                                          + scripts/check_extension_contract.cjs

use fluxdl_engine::*;
use serde_json::json;
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

/// 写一个可执行的假程序。Windows 上需要 `.cmd` 包装，Linux 直接加 shebang。
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
        let content = format!("#!/bin/sh\n{body}");
        std::fs::write(&path, content).unwrap();
        let mut perm = std::fs::metadata(&path).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&path, perm).unwrap();
        path
    }
}

fn fake_aria2_body() -> String {
    "echo \"aria2 version 1.37.0\"\nexit 0\n".to_string()
}

/// 配置一个「yt-dlp / aria2c 都就绪」的引擎。aria2c 故意存在，用来验证
/// 0.3.4 起媒体任务**不再**因为探测到二进制就自动开外部下载器。
async fn engine_with_tools(dir: &Path, yt_body: &str) -> (Arc<Engine>, PathBuf) {
    let tools = dir.join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let calls = dir.join("calls.log");
    let yt = write_exe(&tools, "yt-dlp", yt_body);
    let aria2 = write_exe(&tools, "aria2c", &fake_aria2_body());

    let e = engine(dir);
    let mut options = e.options();
    options.save_dir = dir.to_string_lossy().to_string();
    options.yt_dlp_path = yt.to_string_lossy().to_string();
    options.aria2_path = Some(aria2.to_string_lossy().to_string());
    e.set_options(options).await;
    (e, calls)
}

/// 假 yt-dlp：记录是否收到 `--external-downloader`，落地文件，打印 FLUXDONE。
/// 标题探测那次调用不带 `-P`，只回一行标题、不落文件（避免污染测试进程 cwd）。
fn body_with_ext_log(calls_log: &Path) -> String {
    let log = calls_log.display().to_string();
    format!(
        r#"ext="no"
outdir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--external-downloader" ]; then ext="$a"; fi
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
done
echo "ext=$ext" >> "{log}"
if [ -z "$outdir" ]; then
  echo "Normal Title"
  exit 0
fi
echo "payload" > "$outdir/out.mp4"
echo "FLUXDONE|$outdir/out.mp4"
"#
    )
}

/// 缺口 1：非 B 站分片站点不走 aria2。
///
/// 0.3.3 只排除了 B 站，抖音 / 快手 / 微博 / 小红书 / 爱奇艺 / 优酷 / YouTube
/// 等 DASH 分片站点仍被自动套上 aria2c，碎片小于 `-k4M` 永不切分 → 真机
/// `CN:1`、几百 KB/s。0.3.4 改为「Media 一律交 yt-dlp 原生 + 分片间并发」，
/// 这里把「装了 aria2c 也不会被自动启用」钉成红线。
/// 0.3.6：真实快手 / 抖音页面链接已在 `Engine::add` 被 `media_page_blocker`
/// 提前拒绝（见 functional_036.rs），所以这里改用同构的 `dash.example.com`
/// 路径保留「多站点」形状，避免把「站点能力拦截」和「aria2 裁决」混在
/// 一个断言里 —— 0.3.4 的实现与站点无关，等价性不受影响。
#[tokio::test]
async fn fragmented_sites_never_auto_enable_aria2() {
    let dir = tempfile::tempdir().unwrap();
    let (e, calls) = engine_with_tools(dir.path(), &body_with_ext_log(&dir.path().join("calls.log"))).await;

    let urls = [
        "https://dash.example.com/douyin/7000000000000000001",
        "https://dash.example.com/kuaishou/abc",
        "https://dash.example.com/weibo/1034abc",
        "https://dash.example.com/xiaohongshu/abc",
        "https://dash.example.com/iqiyi/abc",
        "https://dash.example.com/youku/abc",
        "https://dash.example.com/youtube/abcdefghijk",
        "https://www.bilibili.com/video/BV1GysQ6hEgB",
    ];
    let mut ids = Vec::new();
    for url in urls {
        let view = e
            .add(TaskKind::Media, url, NewTaskOptions::default())
            .await
            .unwrap();
        ids.push(view.id);
    }
    for id in &ids {
        let done = wait_done(&e, id, 30).await;
        assert_eq!(done.status, TaskStatus::Completed, "任务应成功：{:?}", done.error);
    }

    let log = std::fs::read_to_string(&calls).unwrap();
    assert!(
        !log.lines().any(|l| l.starts_with("ext=") && !l.contains("ext=no")),
        "任何媒体任务都不得把 aria2c 传给 yt-dlp（分片流会退化成 CN:1），实际记录：\n{log}"
    );
    // 反向确认日志确实覆盖到了多个任务，避免「一条都没跑」的假通过。
    assert!(
        log.lines().filter(|l| l.starts_with("ext=")).count() >= urls.len(),
        "每个任务（含标题探测）都应被记录：\n{log}"
    );
}

/// 缺口 2：非 ASCII 合法标题不被丢（链路级，不只是纯函数）。
///
/// 0.3.3 的「非 CJK 占比 ≥ 50%」规则把葡语 / 俄语 / 泰文 / emoji 标题全部
/// 判成乱码丢弃，下载中一直显示默认名 `video`。这里让假 yt-dlp 在标题探测
/// 阶段返回葡语标题，断言它真的被回填到任务视图（收尾会被产物名覆盖，
/// 所以必须在下载过程中轮询观察中间态）。
#[tokio::test]
async fn non_ascii_title_is_backfilled() {
    let dir = tempfile::tempdir().unwrap();
    let body = r#"outdir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
done
if [ -z "$outdir" ]; then
  echo "SÃO PAULO 4K"
  exit 0
fi
i=0
while [ $i -lt 8 ]; do
  echo "FLUXDL|$((i+1))000|8000|8000|1024|8|t.mp4"
  sleep 0.2
  i=$((i+1))
done
echo "payload" > "$outdir/out.mp4"
echo "FLUXDONE|$outdir/out.mp4"
"#;
    let (e, _) = engine_with_tools(dir.path(), body).await;

    // 显式给一个默认名，确保回填分支 `filename.starts_with("video")` 成立。
    let opts = NewTaskOptions {
        filename: Some("video.mp4".into()),
        ..Default::default()
    };
    let view = e
        .add(TaskKind::Media, "https://dash.example.com/douyin/1", opts)
        .await
        .unwrap();

    let mut saw_title = false;
    let start = Instant::now();
    loop {
        let v = e.get_task(&view.id).await.unwrap();
        if v.filename.contains("SÃO") || v.filename.contains("PAULO") {
            saw_title = true;
        }
        if matches!(v.status, TaskStatus::Completed | TaskStatus::Failed) {
            assert_eq!(v.status, TaskStatus::Completed, "任务失败：{:?}", v.error);
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(20), "超时");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert!(
        saw_title,
        "非 ASCII 合法标题被乱码检测误杀，下载中仍显示默认名"
    );
}

/// 缺口 3：`after_move` / FLUXDONE 缺失时仍能定位并发布产物。
///
/// yt-dlp 版本差异、编码问题或「文件已存在被跳过」都可能不打印 FLUXDONE。
/// 0.3.3 会退化成认领目录内任意最新媒体文件（可能指向别的任务的旧视频），
/// 或直接报「下载完成，但未找到输出的视频文件」。0.3.4 用独占 work_dir +
/// 目录差分，这里验证没有 FLUXDONE 也能拿到正确文件并发布回下载目录。
#[tokio::test]
async fn missing_after_move_still_publishes_output() {
    let dir = tempfile::tempdir().unwrap();
    let body = r#"outdir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
done
if [ -z "$outdir" ]; then
  echo "No After Move Title"
  exit 0
fi
sleep 0.05
# 故意不打印 FLUXDONE：模拟 --print after_move 未输出 / 路径乱码不可用
echo "payload" > "$outdir/only-on-disk.mp4"
"#;
    let (e, _) = engine_with_tools(dir.path(), body).await;
    let view = e
        .add(TaskKind::Media, "https://www.bilibili.com/video/BV1xx", NewTaskOptions::default())
        .await
        .unwrap();
    let done = wait_done(&e, &view.id, 20).await;

    assert_eq!(done.status, TaskStatus::Completed, "缺 FLUXDONE 不应误报失败：{:?}", done.error);
    assert_eq!(done.filename, "only-on-disk.mp4", "应认领本次产物：{done:?}");
    let path = PathBuf::from(&done.save_path);
    assert!(path.exists(), "产物应存在：{}", path.display());
    assert_eq!(
        path.parent(),
        Some(dir.path()),
        "产物必须发布回用户下载目录，不能留在 fluxdl-<id> 子目录：{}",
        path.display()
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"payload\n");
}

/// 缺口 4：并发同目录不串台。
///
/// 0.3.3 所有任务共用 save_dir，目录快照差分会跨任务错配，两个任务可能
/// 指向同一个文件。0.3.4 每个任务独占 work_dir。这里让两个任务同时下载、
/// 各自落地不同名文件，断言双方都认领到自己的产物且内容正确。
#[tokio::test]
async fn concurrent_tasks_do_not_cross_claim_output() {
    let dir = tempfile::tempdir().unwrap();
    let body = r#"outdir=""
url=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
  url="$a"
done
if [ -z "$outdir" ]; then
  echo "Concurrent Title"
  exit 0
fi
name=$(basename "$url")
sleep 0.4
echo "payload-$name" > "$outdir/$name.mp4"
echo "FLUXDONE|$outdir/$name.mp4"
"#;
    let (e, _) = engine_with_tools(dir.path(), body).await;

    let a = e
        .add(TaskKind::Media, "https://example.com/alpha", NewTaskOptions::default())
        .await
        .unwrap();
    let b = e
        .add(TaskKind::Media, "https://example.com/beta", NewTaskOptions::default())
        .await
        .unwrap();
    let da = wait_done(&e, &a.id, 30).await;
    let db = wait_done(&e, &b.id, 30).await;

    assert_eq!(da.status, TaskStatus::Completed, "{:?}", da.error);
    assert_eq!(db.status, TaskStatus::Completed, "{:?}", db.error);
    assert_ne!(da.save_path, db.save_path, "两个任务不能指向同一个文件");
    assert_eq!(da.filename, "alpha.mp4", "任务 A 认领错产物：{da:?}");
    assert_eq!(db.filename, "beta.mp4", "任务 B 认领错产物：{db:?}");
    assert_eq!(std::fs::read(&da.save_path).unwrap(), b"payload-alpha\n");
    assert_eq!(std::fs::read(&db.save_path).unwrap(), b"payload-beta\n");
    assert_eq!(PathBuf::from(&da.save_path).parent(), Some(dir.path()));
    assert_eq!(PathBuf::from(&db.save_path).parent(), Some(dir.path()));
}

/// 用当前结构生成一份完整基线，再删掉后加的字段，模拟 0.1 / 0.2 的 tasks.json。
fn legacy_view(id: &str) -> serde_json::Value {
    let mut value = serde_json::to_value(TaskView::default()).unwrap();
    let obj = value.as_object_mut().unwrap();
    obj.insert("id".into(), json!(id));
    obj.insert("url".into(), json!(format!("https://example.com/{id}.mp4")));
    obj.insert("filename".into(), json!(format!("{id}.mp4")));
    obj.insert("savePath".into(), json!(format!("/tmp/{id}.mp4")));
    // paused 不会被启动调度，避免测试去访问 example.com
    obj.insert("status".into(), json!("paused"));
    for added_later in ["domain", "resumable", "segments", "mime", "format"] {
        obj.remove(added_later);
    }
    value
}

/// 缺口 5：旧版 `tasks.json` 缺字段 + 混入坏条目时不整表丢失。
///
/// 0.3.3 用 `serde_json::from_str::<StoreFile>` 整表解析，一条任务缺
/// `domain` 就 `Err("missing field 'domain'")` → `unwrap_or_default()` →
/// 整份任务列表、已完成记录、续传 part 全部失联。0.3.4 加 `serde(default)`
/// 并改为逐条 `from_value`、坏条目跳过。
#[tokio::test]
async fn legacy_tasks_json_missing_fields_is_recovered() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.json");
    let opts = serde_json::to_value(NewTaskOptions::default()).unwrap();
    let root = json!({
        "options": null,
        "tasks": [
            { "view": legacy_view("legacy-a"), "options": opts },
            { "view": legacy_view("legacy-b"), "options": opts },
            "一条彻底损坏的旧数据",
        ]
    });
    std::fs::write(&path, root.to_string()).unwrap();

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let e = Engine::new(path, tx);
    let tasks = e.tasks().await;

    assert_eq!(tasks.len(), 2, "缺字段的两条应恢复、坏条目应跳过：{tasks:?}");
    let mut ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["legacy-a", "legacy-b"]);
    for t in &tasks {
        assert_eq!(t.status, TaskStatus::Paused);
        assert_eq!(t.domain, "", "缺字段应回落零值，而不是丢掉整条任务");
        assert!(!t.resumable);
        assert!(t.segments.is_empty());
    }
}
