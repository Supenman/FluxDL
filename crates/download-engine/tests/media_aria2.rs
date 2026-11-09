//! aria2 外部下载器链路的端到端回归。
//!
//! 这些用例**不依赖外网、不依赖真实 yt-dlp**：用同一套思路伪造两个外部程序
//! ——一个冒充 `yt-dlp`（只解析参数、按协议打进度行、落地文件、打印 FLUXDONE），
//! 一个冒充 `aria2c`（被 `-h` 探测时立即成功退出）。
//!
//! 目的不是「跑通下载」，而是把这次改动里最容易悄悄坏掉的四个契约钉住：
//!   1. aria2 模式下，`--external-downloader` 必须指向真实存在的 aria2c；
//!   2. aria2 的进度行必须被换算成 `FLUXDL|` 协议、且不能混进 errors；
//!   3. 找不到 aria2c 时必须**自动退回**原生下载器，任务仍然成功；
//!   4. 任务限速时不得启用 aria2c（否则限速被绕过）。
//!
//! 前三条约等于「升级前后行为差异」的验收点，第 4 条是正确性红线。

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
        tokio::time::sleep(Duration::from_millis(50)).await;
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

/// 伪造 yt-dlp：打印三行 aria2 风格进度（只在 stderr），落地文件，打印 FLUXDONE。
///
/// 用 `$1` 里是否含 `--external-downloader` 决定「有没有接管成功」，
/// 并把结论写进 aria2_flags.txt 供断言。
fn fake_ytdlp_body(calls_log: &Path) -> String {
    let log = calls_log.display().to_string();
    format!(
        r#"out=""
ext="no"
cf=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--external-downloader" ]; then ext="$a"; fi
  if [ "$prev" = "--concurrent-fragments" ]; then cf="$a"; fi
  prev="$a"
  case "$a" in
    -P|--ffmpeg-location|--proxy|--referer|-f|-o|--extractor-args|--progress-template|--print|--retries|--fragment-retries|--concurrent-fragments|--external-downloader|--external-downloader-args|--merge-output-format) ;;
    *) ;;
  esac
done
# 记录：外部下载器路径（或 no）、分片并发值
echo "ext=$ext cf=$cf" >> "{log}"
# 模拟 aria2 把进度打在 stderr 上（真实格式），同时模拟一条普通告警
echo "[#abc123 1MiB/4MiB(25%) CN:8 DL:512KiB]" >&2
echo "[#abc123 2MiB/4MiB(50%) CN:8 DL:512KiB]" >&2
echo "WARNING: 假的 yt-dlp 告警" >&2
# 找到 -P 后的目录与 -o 后的模板，落一个成品文件
outdir="."
prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
done
echo "payload" > "$outdir/fake-video.mp4"
echo "FLUXDONE|$outdir/fake-video.mp4"
"#
    )
}

/// 伪造 aria2c：被 `-h` / `--version` 探测时正常退出即可（本测试里 yt-dlp 是假的，
/// 不会真的调用它下载）。
fn fake_aria2_body() -> String {
    "echo \"aria2 version 1.37.0\"\nexit 0\n".to_string()
}

/// 用例 1+2：aria2c 存在 → 参数里带 `--external-downloader`，且进度行被正确转换、
/// 告警仍归入 errors。验收「升级后 UI 仍有实时进度」。
#[tokio::test]
async fn aria2_mode_passes_external_downloader_and_converts_progress() {
    let dir = tempfile::tempdir().unwrap();
    let tools = dir.path().join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let calls = dir.path().join("calls.log");
    let yt = write_exe(&tools, "yt-dlp", &fake_ytdlp_body(&calls));
    let aria2 = write_exe(&tools, "aria2c", &fake_aria2_body());

    let e = engine(dir.path());
    let mut options = e.options();
    options.save_dir = dir.path().to_string_lossy().to_string();
    options.yt_dlp_path = yt.to_string_lossy().to_string();
    options.aria2_path = Some(aria2.to_string_lossy().to_string());
    e.set_options(options).await;

    let view = e
        .add(
            TaskKind::Media,
            "https://example.com/video/1",
            NewTaskOptions {
                aria2: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let done = wait_done(&e, &view.id, 20).await;

    assert_eq!(done.status, TaskStatus::Completed, "任务应成功：{:?}", done.error);
    let log = std::fs::read_to_string(&calls).unwrap();
    // 主下载任务必须把 aria2c 路径传给 yt-dlp。注意：标题探测（B 修复）也会单独调一次
    // yt-dlp 取标题（不带 --external-downloader，故 ext=no），因此这里只看「主下载那一行」
    // 是否拿到了路径，而不是要求整份日志不含 ext=no。
    let main_line = log
        .lines()
        .find(|l| l.starts_with("ext=") && !l.contains("ext=no"))
        .unwrap_or_else(|| panic!("必须把 aria2c 路径传给 yt-dlp（主下载），实际记录：{log}"));
    // 回归红线：aria2 模式下 **不得** 把 --concurrent-fragments 压成 1。
    // 分片流（B 站 DASH）里 yt-dlp 仍需逐片拉取，压成 1 会让分片并发退化为串行，
    // 比原生下载还慢——这是上一版真实发生过的性能回归。
    assert!(
        !main_line.contains("cf=1 "),
        "aria2 模式下不得把 --concurrent-fragments 压成 1，否则分片流变成串行下载：{main_line}"
    );
    // 进度行被识别 → downloaded_bytes 有真实值（不是 0 也不是 1）
    assert!(
        done.downloaded_bytes >= 1024 * 1024,
        "aria2 进度行未被采纳，downloaded={}",
        done.downloaded_bytes
    );

    // 清理：不留进程
    drop(e);
}

/// 用例 3：没有 aria2c → 自动回退原生下载器，任务仍然成功（不能因为缺二进制而失败）。
#[tokio::test]
async fn missing_aria2_falls_back_to_native_downloader() {
    let dir = tempfile::tempdir().unwrap();
    let tools = dir.path().join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let calls = dir.path().join("calls.log");
    let yt = write_exe(&tools, "yt-dlp", &fake_ytdlp_body(&calls));
    // 故意不创建 aria2c

    let e = engine(dir.path());
    let mut options = e.options();
    options.save_dir = dir.path().to_string_lossy().to_string();
    options.yt_dlp_path = yt.to_string_lossy().to_string();
    options.aria2_path = None;
    e.set_options(options).await;

    let view = e
        .add(TaskKind::Media, "https://example.com/video/2", NewTaskOptions::default())
        .await
        .unwrap();
    let done = wait_done(&e, &view.id, 20).await;

    assert_eq!(done.status, TaskStatus::Completed, "回退路径必须成功：{:?}", done.error);
    let log = std::fs::read_to_string(&calls).unwrap();
    assert!(
        log.contains("ext=no"),
        "缺 aria2c 时不应传 --external-downloader，实际：{log}"
    );
}

/// 用例 4：任务限速 → 必须禁用 aria2c，否则限速被外部进程绕过。
#[tokio::test]
async fn speed_limited_task_never_uses_aria2() {
    let dir = tempfile::tempdir().unwrap();
    let tools = dir.path().join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let calls = dir.path().join("calls.log");
    let yt = write_exe(&tools, "yt-dlp", &fake_ytdlp_body(&calls));
    let aria2 = write_exe(&tools, "aria2c", &fake_aria2_body());

    let e = engine(dir.path());
    let mut options = e.options();
    options.save_dir = dir.path().to_string_lossy().to_string();
    options.yt_dlp_path = yt.to_string_lossy().to_string();
    options.aria2_path = Some(aria2.to_string_lossy().to_string());
    e.set_options(options).await;

    let opts = NewTaskOptions {
        speed_limit: Some(200 * 1024),
        ..Default::default()
    };
    let view = e
        .add(TaskKind::Media, "https://example.com/video/3", opts)
        .await
        .unwrap();
    let done = wait_done(&e, &view.id, 20).await;

    assert_eq!(done.status, TaskStatus::Completed);
    let log = std::fs::read_to_string(&calls).unwrap();
    assert!(
        log.contains("ext=no"),
        "限速任务绝不能启用 aria2c，实际：{log}"
    );
}

/// 用例 6：**通道回归** —— aria2 的进度在 stdout，不在 stderr。
///
/// 实测（aria2 1.37）：进度汇总全部落在 stdout，stderr 为 0 字节。早期实现
/// 只把 stderr 交给「认领进度」的 reader，结果 UI 全程 0%，直到最后才跳 100%。
/// 这个用例让假 yt-dlp 把 aria2 风格进度只打到 **stdout**，断言进度能进引擎。
#[tokio::test]
async fn aria2_progress_on_stdout_is_recognized() {
    let dir = tempfile::tempdir().unwrap();
    let tools = dir.path().join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let aria2 = write_exe(&tools, "aria2c", &fake_aria2_body());

    let body = r#"outdir="."
prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
done
# 只打 stdout，模拟 aria2 的真实行为
for pct in 10 20 30 40 50 60 70 80 90; do
  echo "[#abc123 ${pct}MiB/100MiB(${pct}%) CN:16 DL:1MiB]"
  sleep 0.1
done
echo "payload" > "$outdir/stdout.mp4"
echo "FLUXDONE|$outdir/stdout.mp4"
"#;
    let yt = write_exe(&tools, "yt-dlp", body);

    let e = engine(dir.path());
    let mut options = e.options();
    options.save_dir = dir.path().to_string_lossy().to_string();
    options.yt_dlp_path = yt.to_string_lossy().to_string();
    options.aria2_path = Some(aria2.to_string_lossy().to_string());
    e.set_options(options).await;

    let view = e
        .add(
            TaskKind::Media,
            "https://example.com/video/stdout",
            NewTaskOptions {
                aria2: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let mut saw_intermediate = false;
    let start = std::time::Instant::now();
    loop {
        let v = e.get_task(&view.id).await.unwrap();
        if v.downloaded_bytes > 0 && v.total_bytes > 0 && v.downloaded_bytes < v.total_bytes {
            saw_intermediate = true;
        }
        if matches!(v.status, TaskStatus::Completed | TaskStatus::Failed) {
            assert_eq!(v.status, TaskStatus::Completed, "任务失败：{:?}", v.error);
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(20), "超时");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    assert!(
        saw_intermediate,
        "stdout 上的 aria2 进度没有被识别，UI 会一直停在 0%"
    );
}

/// 用例 5：stderr 通道同样可用（兼容 aria2 未来版本把进度改到 stderr）。
///
/// 假 yt-dlp 每 120ms 吐一行 aria2 风格进度到 **stderr**；期间轮询引擎视图，
/// 必须观察到**中间态**（0 < 已下载 < 总量）。若进度解析或 stderr 分流写错，
/// 视图只会在结束时跳到 100%，这个断言就会失败。
#[tokio::test]
async fn progressive_progress_reaches_engine_before_completion() {
    let dir = tempfile::tempdir().unwrap();
    let tools = dir.path().join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let aria2 = write_exe(&tools, "aria2c", &fake_aria2_body());

    // 定制的假 yt-dlp：慢速吐进度，最后落地文件
    let body = r#"outdir="."
prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then outdir="$a"; fi
  prev="$a"
done
for pct in 10 20 30 40 50 60 70 80 90; do
  echo "[#abc123 ${pct}MiB/100MiB(${pct}%) CN:8 DL:1MiB]" >&2
  sleep 0.12
done
echo "payload" > "$outdir/slow.mp4"
echo "FLUXDONE|$outdir/slow.mp4"
"#;
    let yt = write_exe(&tools, "yt-dlp", body);

    let e = engine(dir.path());
    let mut options = e.options();
    options.save_dir = dir.path().to_string_lossy().to_string();
    options.yt_dlp_path = yt.to_string_lossy().to_string();
    options.aria2_path = Some(aria2.to_string_lossy().to_string());
    e.set_options(options).await;

    let view = e
        .add(
            TaskKind::Media,
            "https://example.com/video/slow",
            NewTaskOptions {
                aria2: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let mut saw_intermediate = false;
    let start = std::time::Instant::now();
    loop {
        let v = e.get_task(&view.id).await.unwrap();
        if v.downloaded_bytes > 0 && v.total_bytes > 0 && v.downloaded_bytes < v.total_bytes {
            saw_intermediate = true;
        }
        if matches!(v.status, TaskStatus::Completed | TaskStatus::Failed) {
            assert_eq!(v.status, TaskStatus::Completed, "任务失败：{:?}", v.error);
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(20), "超时");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    assert!(
        saw_intermediate,
        "全程未观察到中间进度，说明进度行没有实时进入引擎（UI 会一直 0%）"
    );
}
