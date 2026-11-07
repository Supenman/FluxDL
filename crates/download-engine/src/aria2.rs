//! aria2c 外部下载器：把 yt-dlp 的「单连接取字节」换成 aria2 的多连接分段拉取。
//!
//! ## 为什么只换下载马达，不自己写 Range 下载
//!
//! B 站 / 抖音这类站点的瓶颈不是「我们不会并发」，而是**单条 TCP 连接被限速**
//! （匿名访问常见 120–300 KB/s）。yt-dlp 的 `--concurrent-fragments N` 只在
//! **同一个流的分片之间**并行，一个几分钟的视频往往只有十几片、片与片之间还
//! 受播放器分片策略约束，实际并发度远低于 N；音轨更是一条连接跑到底。
//!
//! aria2 的 `-x/-s` 是**对一个文件本身**切字节区间并发拉，和分片边界无关。
//! 更关键的是：合并（视频流 + 音频流 → mp4）、格式选择、异常兜底仍然由
//! yt-dlp 负责，我们只把它「取字节」那一步替换掉，正确性损失最小。
//!
//! ## 进度为什么能继续实时刷新
//!
//! aria2 模式下 yt-dlp **不再逐行输出进度模板**（它只在收尾打一次 `100%`），
//! 所以必须由我们盯 aria2 自己的输出，否则 UI 会从「实时进度」退化成
//! 「长时间 0% 然后突然 100%」。
//!
//! 注意：**aria2 没有 `--progress-template`**（那是 yt-dlp 的参数），传过去会
//! 直接以 `unrecognized option` 失败退出。aria2 实际可用的两种实时输出是：
//!
//! ```text
//! [#5fa1f8 44MiB/50MiB(88%) CN:7 DL:43MiB]                  ← 终端式进度条
//! [#a772a2 1.5MiB/200MiB(0%) CN:1 DL:1.5MiB ETA:2m6s]       ← 同上，带 ETA
//! ```
//!
//! 因此这里解析 `[#gid 已下载/总量(pct%) ... DL:速度 ...]` 这种行；速度可能是
//! `43MiB`、`1.5MiB`、`218KiB`、`0B/s`、也可能是 yt-dlp 试运行时的 `--`。

use std::path::{Path, PathBuf};

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::mpsc::UnboundedSender;

/// 每个文件的最大连接数。16 是对「单连接限速型」CDN 的常见甜点值：
/// 低于 8 提速不明显，高于 16 容易触发站点风控，且小文件反而因建连开销变慢。
pub const ARIA2_MAX_CONNECTION_PER_SERVER: u8 = 16;
/// 单个文件被切成几段。与连接数相同，即「每段一条连接」。
pub const ARIA2_SPLIT: u8 = 16;
/// 最小分片大小：小于它的文件**整体单连接**下载，不切分。
///
/// 取 `4M` 而不是更小的值：B 站 DASH 的分片（`.m4s` 视频 / 音频碎片）普遍只有几百 KB
/// 到几 MB，若把阈值设成 1M，每个小碎片都会尝试切 16 段，建连 + 收尾开销会明显超过
/// 收益，表现为「开了 aria2 反而更慢」。抬到 4M 后，小碎片走单连接快速拿完（本来也
/// 快），真正的大文件（整文件直链、高码率长视频）才享受 16 路并发。
pub const ARIA2_MIN_SPLIT_SIZE: &str = "4M";
/// 进度汇总间隔（秒）。1 秒与 UI 的刷新节奏对齐，太密会刷屏、太疏会看着卡。
pub const ARIA2_SUMMARY_INTERVAL: &str = "1";

/// 跨平台的可执行文件名。
pub fn exe_name() -> &'static str {
    if cfg!(windows) {
        "aria2c.exe"
    } else {
        "aria2c"
    }
}

/// 在候选路径里找 aria2c。候选可以是「目录」也可以是「文件本身」。
///
/// 返回 `None` 表示「没有」，调用方必须退回归 yt-dlp 原生下载器。
pub fn locate(candidates: &[PathBuf]) -> Option<PathBuf> {
    for c in candidates {
        if c.is_file() {
            return Some(c.clone());
        }
        let p = c.join(exe_name());
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// 传给 yt-dlp 的 `--external-downloader-args`（单个字符串，`aria2c:` 前缀）。
///
/// yt-dlp 会把 `aria2c:` 之后的内容**按空格切开**后原样交给 aria2c，
/// 因此这里拼出来的每个参数都不能含空格（日志路径放临时目录，一般无空格）。
pub fn downloader_args(log_path: &Path) -> String {
    // 注意别加 `--console-log-level=warn`：它会连带压掉进度汇总（实测 warn 级下
    // stderr 只剩 `Download Results`，进度行不再输出）。aria2 的 notice 级本来
    // 就只有「开始 / 完成 / 汇总表」三类，噪音可控。
    format!(
        "aria2c:-x{conn} -s{split} -k{chunk} --continue=true --auto-file-renaming=false \
         --allow-overwrite=true --summary-interval={interval} --enable-color=false \
         --log={log} --log-level=warn",
        conn = ARIA2_MAX_CONNECTION_PER_SERVER,
        split = ARIA2_SPLIT,
        chunk = ARIA2_MIN_SPLIT_SIZE,
        interval = ARIA2_SUMMARY_INTERVAL,
        log = log_path.display(),
    )
}

/// 把 aria2 的 `43MiB` / `1.5MiB` / `218KiB` / `0B/s` 之类文本换算成字节数。
///
/// 单位是 1024 进制（aria2 与绝大多数下载器一致）；无法识别时返回 `None`，
/// 让调用方保持上一次的数值，而不是把进度清零。
pub fn parse_size(text: &str) -> Option<u64> {
    let t = text.trim();
    if t.is_empty() || t == "--" {
        return None;
    }
    // 去掉可能存在的 "/s"
    let t = t.strip_suffix("/s").unwrap_or(t);
    let split_at = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(t.len());
    let (num, unit) = t.split_at(split_at);
    let num: f64 = num.parse().ok()?;
    if !num.is_finite() || num < 0.0 {
        return None;
    }
    let factor: f64 = match unit.trim() {
        "" | "B" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((num * factor) as u64)
}

/// 解析 aria2 的进度行，转换成本项目统一的 `FLUXDL|...` 协议行。
///
/// 输入形如 `[#5fa1f8 44MiB/50MiB(88%) CN:7 DL:43MiB]`，返回形如
/// `FLUXDL|46137344|52428800|52428800|45088768|1|`。
/// 不符合格式的行返回 `None`（由调用方按普通日志处理）。
pub fn parse_progress_line(line: &str) -> Option<String> {
    let t = line.trim();
    let body = t.strip_prefix("[#")?;
    // gid 之后第一个空格之后才是数据；gid 长度不定（6~16 位十六进制）
    let (_gid, rest) = body.split_once(' ')?;
    // rest: `44MiB/50MiB(88%) CN:7 DL:43MiB]`
    let (size_part, tail) = rest.split_once('(')?;
    let (done_s, total_s) = size_part.split_once('/')?;
    let done = parse_size(done_s)?;
    let total = parse_size(total_s)?;
    if total == 0 {
        return None;
    }
    // 速度：`DL:` 之后到下一个空格或 `]` 结束。
    //
    // aria2 在没有有效速度时会输出 `DL:--`（如本地源、刚建连）。这里把「速度未知」
    // 与「速度 0」区分开：解析成功（含 `DL:0B`）得到真实字节数；解析失败（`--`/空）
    // 用 `-1` 标记。`-1` 由调用方（media.rs）解释为「保留上一次有效速度」，从而避免
    // 速度图表在 `DL:--` 时周期性塌陷到 0，造成虚假的锯齿谷底。
    let speed = tail
        .split_once("DL:")
        .and_then(|(_, after)| after.split([' ', ']']).next())
        .and_then(|raw| {
            let v = raw.trim();
            if v.is_empty() { None } else { Some(v) }
        })
        .and_then(parse_size);
    let speed_field: i64 = speed.map(|v| v as i64).unwrap_or(-1);
    let eta = if let Some(s) = speed.filter(|s| *s > 0) {
        if total > done { (total - done) / s } else { 0 }
    } else {
        0
    };
    // 主流程字段顺序：downloaded | total | total_estimate | speed | eta | filename
    // speed 字段为 `-1` 表示「速度未知」，调用方据此保留上一次有效速度而非归零。
    Some(format!("FLUXDL|{done}|{total}|{total}|{speed_field}|{eta}|"))
}

/// 逐行读 aria2 的进度输出，把进度行转成协议行，其余内容按 `ERR|` 原样透传。
///
/// 与 `media::spawn_line_reader` 一致：读原始字节 + lossy 解码。Windows 中文
/// 系统下 aria2 输出可能带本地代码页字节，不能让一行乱码打断整条链路。
/// 透传而不是丢弃，是因为 aria2 的报错（如 403、Range 不支持）只在它的输出里。
pub fn spawn_progress_reader<R>(reader: R, tx: UnboundedSender<String>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    while let Some(&last) = buf.last() {
                        if last == b'\n' || last == b'\r' {
                            buf.pop();
                        } else {
                            break;
                        }
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    // aria2 的汇总表头、分隔线、空白行不构成有效信息，直接跳过，
                    // 否则它们会挤进「最近错误」列表里污染报错提示。
                    if is_noise(&line) {
                        continue;
                    }
                    let msg = parse_progress_line(&line).unwrap_or_else(|| format!("ERR|{line}"));
                    if tx.send(msg).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// aria2 周期性输出的装饰性内容。
///
/// 关键：`--summary-interval=1` 每秒会输出一段 `*** Download Progress Summary as of ... ***`
/// 汇总块；aria2 又用 `\r` 刷新进度条，管道读到的往往是一整行里**先拼进度片段、
/// 再拼汇总表头**（实测形如 `[#gid 68/88 CN:1 DL:0B] *** Download Progress Summary as of ... ***`）。
/// 这类行以 `[#` 开头，单靠 `starts_with("***")` 拦不住，会被当成 `ERR|` 刷满任务日志，
/// 把真正的错误提示挤掉。因此改用「包含标记」而非「以标记开头」。
pub fn is_noise(line: &str) -> bool {
    let t = line.trim();
    t.is_empty()
        || t.contains("***")
        || t.contains("Download Progress Summary")
        || t.starts_with("===")
        || t.starts_with("---")
        || t.starts_with("FILE: ")
        || t.starts_with("Download Results")
        || t.starts_with("Status Legend")
        || t.starts_with("gid ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncWriteExt};

    #[test]
    fn parse_size_handles_all_units() {
        assert_eq!(parse_size("0B"), Some(0));
        assert_eq!(parse_size("1KiB"), Some(1024));
        assert_eq!(parse_size("1.5MiB"), Some(1024 * 1024 * 3 / 2));
        assert_eq!(parse_size("43MiB"), Some(43 * 1024 * 1024));
        assert_eq!(parse_size("1GiB"), Some(1024 * 1024 * 1024));
        assert_eq!(parse_size("218KiB/s"), Some(218 * 1024));
        assert_eq!(parse_size("--"), None, "速度未知时必须返回 None，而不是 0");
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("abc"), None);
    }

    #[test]
    fn progress_line_converts_to_engine_protocol() {
        let line = "[#5fa1f8 44MiB/50MiB(88%) CN:7 DL:43MiB]";
        let out = parse_progress_line(line).expect("应识别为进度行");
        let p: Vec<&str> = out.trim_start_matches("FLUXDL|").split('|').collect();
        assert_eq!(p[0], (44 * 1024 * 1024).to_string());
        assert_eq!(p[1], (50 * 1024 * 1024).to_string());
        assert_eq!(p[2], p[1], "total_estimate 与 total 取同值");
        assert_eq!(p[3], (43 * 1024 * 1024).to_string());
        assert_eq!(p[4], "0", "剩 6MiB / 43MiB/s 不足 1 秒，取整为 0");
    }

    #[test]
    fn progress_line_with_eta_and_zero_speed_is_ok() {
        let line = "[#a772a2 1.5MiB/200MiB(0%) CN:1 DL:0B]";
        let out = parse_progress_line(line).unwrap();
        let p: Vec<&str> = out.trim_start_matches("FLUXDL|").split('|').collect();
        assert_eq!(p[3], "0", "速度 0 时保留进度，不清零总进度");
        assert_eq!(p[4], "0");
    }

    /// 回归：`DL:--` 曾被当成「非进度行」整行丢弃，导致 UI 全程 0%。
    /// 速度未知时进度行仍须保留，速度字段用 `-1` 哨兵标记，由调用方（media.rs）
    /// 解释为「保留上一次有效速度」，避免图表谷底塌陷到 0 造成虚假锯齿。
    #[test]
    fn progress_line_with_unknown_speed_is_still_progress() {
        let line = "[#01449c 60MiB/120MiB(50%) CN:16 DL:--]";
        let out = parse_progress_line(line).expect("速度未知也必须算进度行");
        let p: Vec<&str> = out.trim_start_matches("FLUXDL|").split('|').collect();
        assert_eq!(p[0], (60 * 1024 * 1024).to_string());
        assert_eq!(p[1], (120 * 1024 * 1024).to_string());
        assert_eq!(p[3], "-1", "速度未知必须用 -1 哨兵，由调用方保留上次速度");
    }

    #[test]
    fn real_aria2_line_from_windows_run_is_parsed() {
        // 这条来自真实运行的原始输出（Windows/Linux 同格式）
        let line = "[#01449c 60MiB/120MiB(50%) CN:16 DL:4.9MiB ETA:12s]";
        assert!(parse_progress_line(line).is_some(), "真实行必须能解析：{line:?}");
    }

    #[test]
    fn non_progress_lines_are_rejected() {
        assert!(parse_progress_line("[#abc 1MiB]").is_none());
        assert!(parse_progress_line("[MEMORY] 100MiB").is_none());
        assert!(parse_progress_line("ERROR: something").is_none());
        assert!(parse_progress_line("").is_none());
    }

    #[test]
    fn noise_lines_are_skipped() {
        assert!(is_noise(""));
        assert!(is_noise("   "));
        assert!(is_noise("*** Download Progress Summary ***"));
        assert!(is_noise("============================="));
        assert!(is_noise("FILE: ./v.mp4"));
        assert!(is_noise("gid   |stat|avg speed  |path/URI"));
        assert!(!is_noise("[#5fa1f8 44MiB/50MiB(88%) CN:7 DL:43MiB]"));
        assert!(!is_noise("11/06 [ERROR] CUID#10 - Download aborted."));
    }

    /// 回归：aria2 的汇总行经过 `\r\n` 拼接后不再以 `***` 开头，而是
    /// `[#gid 68/88 CN:1 DL:0B] *** Download Progress Summary as of ... ***`。
    /// 旧实现用 `starts_with("***")` 拦不住，整段被当作 `ERR|` 刷满日志（真机截图 9 行）。
    #[test]
    fn noise_lines_include_concatenated_progress_summary() {
        let concat = "[#1f2e3d 68/88 CN:1 DL:0B] *** Download Progress Summary as of Fri Nov 7 10:21:33 2025 ***";
        assert!(is_noise(concat), "拼接后的汇总行必须被过滤");
        assert!(is_noise("Download Progress Summary as of Fri Nov 7"));
        // 过滤后这条不能再被解析成进度
        assert!(parse_progress_line(concat).is_none());
    }

    #[test]
    fn downloader_args_never_contain_progress_template() {
        // 回归保护：aria2 不认 --progress-template，带上它会导致下载直接失败。
        let args = downloader_args(Path::new("/tmp/a.log"));
        assert!(args.starts_with("aria2c:"));
        assert!(!args.contains("--progress-template"), "aria2 没有这个参数");
        assert!(args.contains("-x16"));
        assert!(args.contains("-s16"));
        assert!(args.contains("-k4M"));
        assert!(args.contains("--continue=true"));
        assert!(args.contains("--auto-file-renaming=false"));
        assert!(args.contains("--summary-interval=1"));
        // 回归保护：console-log-level=warn 会把进度汇总一起压掉
        assert!(!args.contains("--console-log-level"), "不能压 console 日志级别");
    }

    /// 回归保护：最小分片阈值不能调小。
    ///
    /// B 站 DASH 的分片普遍只有几百 KB～几 MB，阈值太小时每个小碎片都会尝试切 16 段，
    /// 建连 + 收尾开销盖过收益，实测「开了 aria2 反而更慢」。
    #[test]
    fn min_split_size_stays_large_enough_for_fragments() {
        assert_eq!(ARIA2_MIN_SPLIT_SIZE, "4M", "小分片场景下阈值不能调小");
        let mib: u8 = ARIA2_MIN_SPLIT_SIZE.trim_end_matches('M').parse().unwrap();
        assert!(mib >= 4, "阈值至少 4M，否则 B 站小分片会被切碎");
    }

    /// 回归保护：参数串按空格切开后不得出现空参数。
    ///
    /// yt-dlp 把 `aria2c:` 之后的内容按空格切开原样交给 aria2c，一旦出现连续空格
    /// （例如源码里多行字符串的缩进没被 `\` 续行吃掉），就会产生空参数。
    #[test]
    fn downloader_args_have_no_empty_segments() {
        let args = downloader_args(Path::new("/tmp/a.log"));
        let body = args.trim_start_matches("aria2c:");
        for (i, seg) in body.split(' ').enumerate() {
            assert!(!seg.is_empty(), "第 {i} 段是空参数：{args}");
        }
    }

    #[test]
    fn locate_accepts_dir_and_file_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(exe_name());
        std::fs::write(&exe, b"stub").unwrap();
        assert_eq!(locate(&[dir.path().to_path_buf()]).unwrap(), exe);
        assert_eq!(locate(std::slice::from_ref(&exe)).unwrap(), exe);
    }

    #[test]
    fn locate_returns_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(locate(&[dir.path().to_path_buf()]).is_none());
    }

    #[tokio::test]
    async fn reader_forwards_progress_and_errors_but_drops_noise() {
        let (mut w, r) = duplex(2048);
        let payload = b"[#5fa1f8 44MiB/50MiB(88%) CN:7 DL:43MiB]\n*** summary ***\n11/06 [ERROR] boom\n\n";
        let owned = payload.to_vec();
        tokio::spawn(async move {
            w.write_all(&owned).await.unwrap();
            drop(w);
        });
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        spawn_progress_reader(r, tx);
        let mut lines = Vec::new();
        while let Some(l) = rx.recv().await {
            lines.push(l);
        }
        assert_eq!(lines.len(), 2, "只保留进度行与错误行：{lines:?}");
        assert!(lines[0].starts_with("FLUXDL|"));
        assert_eq!(lines[1], "ERR|11/06 [ERROR] boom");
    }
}
