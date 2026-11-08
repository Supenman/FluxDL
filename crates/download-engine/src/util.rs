use percent_encoding::percent_decode_str;
use reqwest::header::HeaderMap;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use url::Url;

const MAX_STEM: usize = 150;

pub fn sanitize_filename(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        let bad = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0')
            || ch.is_control();
        out.push(if bad { '_' } else { ch });
    }
    let trimmed = out.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        return "download.bin".into();
    }
    // Keep extension when truncating very long names.
    if trimmed.chars().count() > MAX_STEM + 40 {
        let path = Path::new(trimmed);
        let ext = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let stem: String = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let keep: String = stem.chars().take(MAX_STEM).collect();
        format!("{keep}{ext}")
    } else {
        trimmed.to_string()
    }
}

const GENERIC_STEMS: &[&str] = &[
    "download",
    "downloadfile",
    "getfile",
    "get",
    "file",
    "index",
    "unnamed",
    "attachment",
];

/// 形如 `download`、`index` 这类没有信息量的名字（通常是接口路径）。
pub fn looks_generic(filename: &str) -> bool {
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if stem.is_empty() {
        return true;
    }
    GENERIC_STEMS.contains(&stem.as_str())
}

fn filename_from_query(url: &Url) -> Option<String> {
    for (key, value) in url.query_pairs() {
        let key = key.to_ascii_lowercase();
        if !matches!(
            key.as_str(),
            "filename" | "file" | "name" | "fn" | "download" | "response-content-disposition"
        ) {
            continue;
        }
        let raw = value.to_string();
        let Some(candidate) = (if key == "response-content-disposition" {
            raw.split("filename=")
                .nth(1)
                .map(|s| s.trim_matches('"').to_string())
        } else {
            Some(raw.split(['/', '\\']).last().unwrap_or(&raw).to_string())
        }) else {
            continue;
        };
        let candidate = percent_decode_str(&candidate).decode_utf8_lossy().to_string();
        if !candidate.trim().is_empty() {
            return Some(sanitize_filename(&candidate));
        }
    }
    None
}

pub fn filename_from_url(url: &Url) -> Option<String> {
    let from_path = url
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|last| !last.trim().is_empty())
        .map(|last| {
            let decoded = percent_decode_str(last).decode_utf8_lossy().to_string();
            sanitize_filename(&decoded)
        });

    // 路径只是 /download、/get 这类接口（或没有扩展名）时，改从查询参数里找真实文件名。
    if let Some(name) = &from_path {
        let has_extension = Path::new(name).extension().is_some();
        if has_extension && !looks_generic(name) {
            return Some(name.clone());
        }
    }
    if let Some(name) = filename_from_query(url) {
        return Some(name);
    }
    from_path
}

pub fn filename_from_headers(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get(reqwest::header::CONTENT_DISPOSITION)?
        .to_str()
        .ok()?;
    let mut fallback = None;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=") {
            let rest = rest.trim_matches('"');
            if let Some(idx) = rest.find("''") {
                let encoded = &rest[idx + 2..];
                if let Ok(decoded) = percent_decode_str(encoded).decode_utf8() {
                    return Some(sanitize_filename(decoded.as_ref()));
                }
            }
        }
        if let Some(rest) = part.strip_prefix("filename=") {
            fallback = Some(sanitize_filename(rest.trim_matches('"').trim()));
        }
    }
    fallback
}

pub fn total_from_content_range(headers: &HeaderMap) -> Option<u64> {
    let raw = headers.get("content-range")?.to_str().ok()?;
    let total = raw.rsplit('/').next()?.trim();
    if total == "*" {
        return None;
    }
    total.parse().ok()
}

pub fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    unique_path_reserved(dir, filename, &std::collections::HashSet::new())
}

/// 与 `unique_path` 相同，但额外避开「已被其它任务占用」的路径。
/// 判定同时考虑最终文件和 `{name}.fluxdl-part`，因为进行中的任务是写在 part 里的。
pub fn unique_path_reserved(
    dir: &Path,
    filename: &str,
    reserved: &std::collections::HashSet<PathBuf>,
) -> PathBuf {
    let taken = |p: &Path| -> bool {
        if p.exists() {
            return true;
        }
        // 进行中的任务只写了 part，最终文件还不存在，但路径已被占用。
        PathBuf::from(format!("{}.fluxdl-part", p.to_string_lossy())).exists()
    };

    let first = dir.join(filename);
    if !taken(&first) && !reserved.contains(&first) {
        return first;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut candidate = first;
    for i in 1..1000 {
        candidate = dir.join(format!("{stem} ({i}){ext}"));
        if !taken(&candidate) && !reserved.contains(&candidate) {
            return candidate;
        }
    }
    candidate
}

pub fn ensure_dir(path: &Path) -> io::Result<()> {
    if !path.exists() {
        std::fs::create_dir_all(path)?;
    }
    Ok(())
}

/// Absolute write at an offset, without relying on per-handle cursors.
/// This is what makes parallel segments safely share one sparse file.
pub fn write_at(file: &File, buf: &[u8], offset: u64) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut written = 0usize;
        while written < buf.len() {
            let n = file.seek_write(&buf[written..], offset + written as u64)?;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::WriteZero, "write returned 0"));
            }
            written += n;
        }
        Ok(())
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        let mut written = 0usize;
        while written < buf.len() {
            let n = file.write_at(&buf[written..], offset + written as u64)?;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::WriteZero, "write returned 0"));
            }
            written += n;
        }
        Ok(())
    }
}

pub fn plan_segments(total: u64, connections: u8) -> Vec<(u64, u64)> {
    if total == 0 {
        return vec![(0, 0)];
    }
    let min_chunk: u64 = 1024 * 1024;
    let n = (connections.max(1) as u64)
        .min((total / min_chunk).max(1)) as usize;
    let chunk = total / n as u64;
    let mut out = Vec::with_capacity(n);
    let mut start = 0u64;
    for i in 0..n {
        let end = if i + 1 == n { total - 1 } else { start + chunk - 1 };
        out.push((start, end));
        start = end + 1;
    }
    out
}

/// 瞬时速度（B/s）的整数指数移动平均平滑。
///
/// 为什么需要它：`tick()` 每 500ms 用 `Δbytes/dt` 算出的瞬时值会被 TCP 抖动、
/// 分段写入节奏、分片切换放大成尖峰与谷底；直接显示就是速度数字乱跳、曲线锯齿，
/// ETA 也跟着剧烈摆动。EMA 用 0.3 的新样本权重削峰，同时保留趋势。
///
/// - `prev == 0`（起步 / 刚恢复）：直接采用 `instant`，避免速度从 0 缓慢爬升；
/// - `instant == 0`（本周期确实没读到字节）：按 0.6 衰减，既不瞬断也不长期挂高；
/// - 其余：`(prev*7 + instant*3) / 10`。
///
/// 用 u128 做中间量，杜绝极端值下的溢出。速度未知（-1）由调用方拦截，不进本函数。
pub fn smooth_speed(prev: u64, instant: u64) -> u64 {
    if prev == 0 {
        return instant;
    }
    if instant == 0 {
        return (prev as u128 * 6 / 10) as u64;
    }
    ((prev as u128 * 7 + instant as u128 * 3) / 10) as u64
}

/// 剩余时间（秒）：与「平滑速度」同口径重算，杜绝 ETA 随瞬时速度 / 分片切换跳字。
///
/// Media 与 HTTP 两条通道共用本函数，保证同一时刻显示的速度与剩余时间自洽：
///  · 仅在总量有效（`total > downloaded`）且平滑速度 > 0 时重算；
///  · 总量未知、已完成、或速度未知（0）时退回 `fallback`（解析器原始 ETA / 无值），
///    不显示虚假的 0，也不因分母缺失而丢掉已有估计；
///  · `speed.max(1)` 只做除零保护，正常路径不会命中。
pub fn eta_from_speed(
    total: u64,
    downloaded: u64,
    speed: u64,
    fallback: Option<u64>,
) -> Option<u64> {
    if total > downloaded && speed > 0 {
        Some(total.saturating_sub(downloaded) / speed.max(1))
    } else {
        fallback
    }
}

/// 字节差分兜底的最小采样间隔（秒）：进度行过密时放大成尖峰，不可信。
pub const SPEED_DELTA_MIN_SECS: f64 = 0.1;

/// 单帧瞬时速度（B/s）推导：从一条 media 进度行的 `speed` 字段 + 字节增量得到。
///
/// 返回 `None` 表示「本帧速度未知」，调用方应**保留上一次平滑速度**，
/// 绝不能把 0 写进 `view.speed_bps`——否则前端 `formatSpeed` 显示 `—`，
/// 而 ETA 仍由解析器给出有限值，出现「有剩余时间却没速度」的矛盾画面
/// （0.3.9 真机截图：B 站任务 11%、剩余 4 秒、速度 `—`）。
///
/// ## 为什么不能再用 `parse::<i64>()`
/// yt-dlp 的 `%(progress.speed)s` 常输出**浮点**字符串（如 `1234567.89`、
/// `9876543.0`），`parse::<i64>()` 一律失败 → -1 → 平滑速度恒为 0 → `—`；
/// 而 `%(progress.eta)s` 用 f64 解析成功，于是速度与 ETA 两个口径打架。
/// 这里统一用 f64 解析，整数 / 浮点都接受。
///
/// ## 字段未知时的兜底
/// 分片切换 / 合并阶段 speed 字段可能是 `NA` / `None` / 空字符串。此时用
/// 「字节增量 / 时间增量」补一个真实速度；`dt` 下限防止进度行过密放大成尖峰，
/// 字节无增长（合并 / 暂停）时返回 `None`，由调用方沿用上一帧平滑值。
pub fn progress_speed(
    speed_field: &str,
    prev_bytes: u64,
    bytes: u64,
    dt_secs: f64,
) -> Option<u64> {
    if let Ok(v) = speed_field.trim().parse::<f64>() {
        if v.is_finite() && v >= 0.0 {
            return Some(v as u64);
        }
    }
    if dt_secs >= SPEED_DELTA_MIN_SECS && bytes > prev_bytes {
        return Some(((bytes - prev_bytes) as f64 / dt_secs) as u64);
    }
    None
}

/// Media 进度行的速度采样状态（纯数据，便于用 f64 时间戳做确定性测试）。
///
/// `speed` 是 `view.speed_bps` 的唯一来源；`at` / `bytes` 是字节差分兜底的
/// 窗口起点，默认就是「任务启动时刻 (0s, 0B)」—— media 任务的 downloaded
/// 本就从 0 累积，首帧即可参与差分，无需单独的「建立基线」分支。
#[derive(Default, Clone, Copy, Debug)]
pub struct SpeedSample {
    pub at: f64,
    pub bytes: u64,
    pub speed: u64,
}

impl SpeedSample {
    /// 用一条进度行推进采样：解析速度字段（浮点优先），NA 时用字节差分兜底，
    /// 结果过 EMA。**未知帧保留上一次平滑速度，绝不写 0** —— 这是修复
    /// 「有剩余时间却没速度」的关键：不把 0 发布给前端。
    ///
    /// 未知帧也不推进基线，让时间窗口继续累积，直到 `dt` 达标或字节重新增长；
    /// 这样分片合并期的短暂停顿不会把「增量/极短 dt」放大成尖峰。
    pub fn advance(&mut self, now: f64, bytes: u64, speed_field: &str) {
        let dt = (now - self.at).max(0.0);
        if let Some(v) = progress_speed(speed_field, self.bytes, bytes, dt) {
            self.speed = smooth_speed(self.speed, v);
            self.at = now;
            self.bytes = bytes;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smooth_speed_starts_immediately() {
        // 起步或恢复后不能让速度从 0 缓慢爬升，用户第一眼就该看到真实值。
        assert_eq!(smooth_speed(0, 2_000_000), 2_000_000);
        assert_eq!(smooth_speed(0, 0), 0);
    }

    #[test]
    fn smooth_speed_holds_steady() {
        assert_eq!(smooth_speed(1_000_000, 1_000_000), 1_000_000);
    }

    #[test]
    fn smooth_speed_clips_spike_and_valley() {
        // 瞬时值翻 5 倍，平滑后只上抬到 2.2 倍；瞬时掉到 1/5，平滑后不低于 0.76 倍。
        assert_eq!(smooth_speed(1_000, 5_000), 2_200);
        assert_eq!(smooth_speed(1_000, 200), 760);
    }

    #[test]
    fn smooth_speed_zero_decays_not_cliffs() {
        // 真实 0 字节周期要能回落，但不能一帧砸到 0 制造谷底。
        assert_eq!(smooth_speed(1_000, 0), 600);
        let mut v = 1_000u64;
        for _ in 0..20 {
            v = smooth_speed(v, 0);
        }
        assert_eq!(v, 0, "持续无字节应最终衰减到 0");
    }

    #[test]
    fn smooth_speed_no_overflow() {
        let max = u64::MAX;
        let v = smooth_speed(max, max);
        assert_eq!(v, max, "等值的极端输入不得溢出或改变");
    }

    #[test]
    fn smooth_speed_flattens_a_spiky_series() {
        // 0.3.8 的核心验收：一串带尖峰的瞬时速度，平滑后的相邻帧跳变
        // 必须显著小于原始序列，否则「速度锯齿」没有真正被削掉。
        let raw = [1_000u64, 9_000, 1_200, 8_500, 900, 9_500, 1_100, 8_800];
        let mut smoothed = Vec::new();
        let mut prev = 0u64;
        for &v in &raw {
            prev = smooth_speed(prev, v);
            smoothed.push(prev);
        }
        let spread = |xs: &[u64]| -> u64 {
            xs.windows(2)
                .map(|w| w[0].abs_diff(w[1]))
                .max()
                .unwrap_or(0)
        };
        assert!(
            spread(&smoothed) < spread(&raw) / 2,
            "平滑序列 {} 的最大跳变 {} 应小于原始 {} 的一半",
            format!("{smoothed:?}"),
            spread(&smoothed),
            spread(&raw)
        );
    }

    #[test]
    fn sanitize_windows_illegal() {
        assert_eq!(sanitize_filename("a:b/c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_filename("   "), "download.bin");
    }

    #[test]
    fn content_disposition_utf8() {
        let mut h = HeaderMap::new();
        h.insert(
            "content-disposition",
            "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip".parse().unwrap(),
        );
        assert_eq!(filename_from_headers(&h).unwrap(), "中文.zip");
    }

    #[test]
    fn content_disposition_ascii() {
        let mut h = HeaderMap::new();
        h.insert(
            "content-disposition",
            "attachment; filename=\"report 2024.pdf\"".parse().unwrap(),
        );
        assert_eq!(filename_from_headers(&h).unwrap(), "report 2024.pdf");
    }

    #[test]
    fn generic_path_falls_back_to_query() {
        let url = Url::parse("https://example.com/download?file=Setup%20v2.exe").unwrap();
        assert_eq!(filename_from_url(&url).unwrap(), "Setup v2.exe");
    }

    #[test]
    fn s3_response_disposition_param() {
        let url = Url::parse(
            "https://example.com/object?response-content-disposition=attachment%3B%20filename%3D%22demo.zip%22",
        )
        .unwrap();
        assert_eq!(filename_from_url(&url).unwrap(), "demo.zip");
    }

    #[test]
    fn normal_path_wins_over_query() {
        let url = Url::parse("https://example.com/files/demo.zip?name=other.rar").unwrap();
        assert_eq!(filename_from_url(&url).unwrap(), "demo.zip");
    }

    #[test]
    fn detects_generic_names() {
        assert!(looks_generic("download"));
        assert!(looks_generic("index.html"));
        assert!(!looks_generic("report 2024.pdf"));
        assert!(!looks_generic("movie.mp4"));
    }

    #[test]
    fn segments_cover_everything() {
        let total = 10 * 1024 * 1024;
        let segs = plan_segments(total, 8);
        assert_eq!(segs.len(), 8);
        assert_eq!(segs[0].0, 0);
        assert_eq!(segs.last().unwrap().1, total - 1);
        for w in segs.windows(2) {
            assert_eq!(w[0].1 + 1, w[1].0);
        }
    }

    #[test]
    fn small_file_single_segment() {
        assert_eq!(plan_segments(1000, 8), vec![(0, 999)]);
    }

    #[test]
    fn eta_from_speed_uses_smoothed_speed() {
        // 总量 100、已下 20、平滑速度 10 → 8 秒，与 view.speed_bps 同口径。
        assert_eq!(eta_from_speed(100, 20, 10, Some(999)), Some(8));
    }

    #[test]
    fn eta_from_speed_overrides_stale_parser_eta() {
        // 有有效平滑速度时，解析器给的旧 ETA 不参与，避免两个口径打架。
        assert_eq!(eta_from_speed(100, 0, 10, Some(3)), Some(10));
    }

    #[test]
    fn eta_from_speed_falls_back_when_unknown() {
        assert_eq!(
            eta_from_speed(0, 0, 10, Some(42)),
            Some(42),
            "总量未知应退回解析器 ETA"
        );
        assert_eq!(
            eta_from_speed(100, 20, 0, Some(42)),
            Some(42),
            "速度未知应退回解析器 ETA"
        );
        assert_eq!(
            eta_from_speed(100, 100, 10, Some(42)),
            Some(42),
            "已完成应退回解析器 ETA"
        );
        assert_eq!(eta_from_speed(0, 0, 0, None), None, "无值兜底应返回 None");
    }

    #[test]
    fn eta_from_speed_no_fallback_still_computes() {
        assert_eq!(eta_from_speed(100, 20, 10, None), Some(8));
    }

    #[test]
    fn eta_from_speed_damps_spike_jump() {
        // 核心验收：瞬时速度翻倍（模拟尖峰）经 EMA 后只上抬到 1.3 倍，
        // 重算出的 ETA 跳变应显著小于原始 2 倍，不再剧烈跳字。
        let total = 1_000_000u64;
        let base = 100_000u64;
        let eta_base = eta_from_speed(total, 0, base, None).unwrap();
        let eta_spike_raw = eta_from_speed(total, 0, base * 2, None).unwrap();
        let smoothed = smooth_speed(base, base * 2); // 130_000
        let eta_smoothed = eta_from_speed(total, 0, smoothed, None).unwrap();
        assert!(eta_spike_raw < eta_smoothed && eta_smoothed < eta_base);
        assert!(
            (eta_base - eta_smoothed) < (eta_base - eta_spike_raw),
            "平滑后的 ETA 跳变必须小于未平滑的跳变"
        );
    }

    // ---- 0.3.9：速度 `—` 回归（真机截图：进度 / 剩余时间有值，速度却是 —）----

    #[test]
    fn progress_speed_accepts_yt_dlp_float_speed() {
        // 根因复现：yt-dlp 的 %(progress.speed)s 是浮点串，parse::<i64>() 会
        // 全部落到 -1，导致速度恒 0。这里必须识别为有效速度。
        assert_eq!(progress_speed("1234567.89", 0, 0, 0.0), Some(1_234_567));
        assert_eq!(progress_speed("9876543.0", 0, 0, 0.0), Some(9_876_543));
        assert_eq!(progress_speed("524288", 0, 0, 0.0), Some(524_288));
        assert_eq!(progress_speed(" 262144.5 ", 0, 0, 0.0), Some(262_144));
    }

    #[test]
    fn progress_speed_falls_back_to_byte_delta_when_na() {
        // 分片切换 / 合并阶段 speed 字段为 NA / None / 空，仍有字节增量，
        // 此时用「增量 / 时间」兜底出真实速度，而不是让速度塌成 0。
        for field in ["NA", "None", "", "-1", "nan", "inf"] {
            assert_eq!(
                progress_speed(field, 1_000_000, 2_000_000, 1.0),
                Some(1_000_000),
                "字段 {field:?} 应走字节差分兜底"
            );
        }
    }

    #[test]
    fn progress_speed_returns_none_when_undeterminable() {
        // 间隔过密（放大成尖峰）、字节无增长（合并/暂停）、字节倒退：
        // 都返回 None，调用方保留上一次平滑值，不写 0、不砸谷底。
        assert_eq!(progress_speed("NA", 0, 1_000_000, 0.01), None);
        assert_eq!(progress_speed("NA", 2_000_000, 2_000_000, 1.0), None);
        assert_eq!(progress_speed("NA", 3_000_000, 2_000_000, 1.0), None);
        assert_eq!(progress_speed("-5", 0, 0, 0.0), None);
    }

    #[test]
    fn progress_speed_reported_field_wins_over_delta() {
        // 解析器给了有效速度时优先用它，不被字节差分覆盖（aria2 的 DL 行）。
        assert_eq!(progress_speed("4096.0", 0, 9_000_000, 1.0), Some(4096));
    }

    #[test]
    fn speed_sample_end_to_end_kills_the_dash() {
        // 复现截图那条链路：连续几帧 speed=NA、字节持续涨、ETA 有值。
        // 旧实现 parse::<i64>() 恒 -1 → speed 恒 0 → 前端 `—`；
        // 新状态机每帧都用字节差分推进 EMA，速度始终 > 0，与 ETA 同口径。
        let mut sample = SpeedSample::default();
        let frames: [(u64, f64); 4] = [
            (1_000_000, 0.5),
            (2_500_000, 1.0),
            (4_000_000, 1.5),
            (5_500_000, 2.0),
        ];
        for (bytes, at) in frames {
            sample.advance(at, bytes, "NA");
            assert!(sample.speed > 0, "第 {at}s 帧速度不得塌成 0（截图回归）");
        }
        // 有速度和总量时，ETA 由平滑速度重算，与速度自洽。
        let eta = eta_from_speed(68_300_000, 5_500_000, sample.speed, Some(4));
        assert!(eta.is_some() && sample.speed > 0);
    }

    #[test]
    fn speed_sample_mixed_float_and_na_frames() {
        // 真实 yt-dlp 输出会浮点帧 / NA 帧交替（分片切换、合并阶段）。
        // 首帧浮点立即起步；NA 帧推进字节差分；即使某帧窗口不足也不写 0。
        let mut sample = SpeedSample::default();
        sample.advance(0.10, 1_000_000, "2000000.5");
        assert_eq!(sample.speed, 2_000_000, "首帧浮点应即时起步");
        let before = sample.speed;
        sample.advance(0.11, 1_000_100, "NA"); // 窗口仅 0.01s，不足以差分
        assert_eq!(sample.speed, before, "窗口不足的 NA 帧必须保留上次速度");
        sample.advance(0.60, 2_000_000, "NA"); // 累积够窗口 → 字节差分
        assert!(sample.speed > 0, "字节差分兜底后速度仍应 > 0");
        sample.advance(1.10, 2_000_000, "NA"); // 字节不涨（合并阶段）
        assert!(sample.speed > 0, "合并阶段也不得把速度砸成 0");
    }

    #[test]
    fn speed_sample_never_publishes_zero_from_a_live_stream() {
        // 逐帧断言：只要字节在增长，任何一帧的 speed 都不为 0。
        // 这是「下载中却显示 —」的直接反例（formatSpeed(0) === "—"）。
        let mut sample = SpeedSample::default();
        let mut bytes = 0u64;
        for i in 1..=20u64 {
            bytes += 512_000;
            let field = if i % 3 == 0 { "NA" } else { "3145728.75" };
            sample.advance(i as f64 * 0.35, bytes, field);
            assert!(sample.speed > 0, "第 {i} 帧速度塌 0");
        }
    }
}
