use percent_encoding::percent_decode_str;
use reqwest::header::HeaderMap;
use sha2::{Digest, Sha256};
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

// --------------------------------------------------------------------------- //
// 分片写后回读校验（0.4.0 A 档）
//
// 背景：分段下载把每个 Range 的响应体经 `write_at` 直接写到同一个稀疏 .part
// 文件的绝对偏移。一旦出现「长度对、内容是 0」的稀疏空洞、并发分段越界互相
// 覆盖、或磁盘写未真正落盘，光靠 `downloaded == total` 完全发现不了——用户会
// 拿到一个大小正确却打不开的损坏文件（0.3.9 的 P0-2 是同类问题的一种）。
//
// 做法：segment_loop 在「写盘的同时」用 DigestSink 对流过的字节增量算 SHA-256，
// 记录本次真正写下的绝对区间；全部结束后由 verify_regions 从 .part 回读同一
// 区间重算比对。不一致就拒绝 finish_file、不产生最终文件、强制全量重下。
// 注意：这里校验的是「写盘完整性」（网络字节 == 落盘字节），不是与服务器给的
// 期望哈希比对——HTTP 普遍没有 Content-MD5，不做无依据的真实性断言。
// --------------------------------------------------------------------------- //

/// 与 `write_at` 对称的绝对偏移读取（同样是 &self，不移动文件游标，可供并发分段共享）。
pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buf, offset)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buf, offset)
    }
}

const VERIFY_BUF: usize = 64 * 1024;

/// 增量摘要器：包一层 Sha256，把 sha2 完全封在 util 内，http.rs 只依赖本模块。
#[derive(Clone, Default)]
pub struct DigestSink {
    hasher: Sha256,
}

/// 本次运行中某个分段写下的字节区间及其摘要（start 为绝对文件偏移，len 为字节数）。
#[derive(Clone, Debug)]
pub struct SegmentDigest {
    pub start: u64,
    pub len: u64,
    pub hash: [u8; 32],
}

impl DigestSink {
    pub fn new() -> Self {
        Self { hasher: Sha256::new() }
    }
    pub fn update(&mut self, bytes: &[u8]) {
        self.hasher.update(bytes);
    }
    /// 收尾成一条可回读校验记录。`end_pos` 是本分段写完后的绝对游标。
    pub fn finish(&self, start: u64, end_pos: u64) -> SegmentDigest {
        let out = self.hasher.clone().finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&out);
        SegmentDigest {
            start,
            len: end_pos.saturating_sub(start),
            hash,
        }
    }
}

/// 计算 .part 文件 `[start, start+len)` 区间的 SHA-256（分块读，避免一次分配整段）。
pub fn hash_region(file: &File, start: u64, len: u64) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; VERIFY_BUF];
    let mut off = start;
    let mut left = len;
    while left > 0 {
        let want = (left as usize).min(VERIFY_BUF);
        let n = read_at(file, &mut buf[..want], off)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "回读校验：文件提前结束",
            ));
        }
        hasher.update(&buf[..n]);
        off += n as u64;
        left -= n as u64;
    }
    let out = hasher.finalize();
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&out);
    Ok(hash)
}

/// 逐段回读比对；返回第一个不一致的记录下标（None = 全部一致）。
pub fn verify_regions(file: &File, digests: &[SegmentDigest]) -> io::Result<Option<usize>> {
    for (i, d) in digests.iter().enumerate() {
        if d.len == 0 {
            continue;
        }
        let got = hash_region(file, d.start, d.len)?;
        if got != d.hash {
            return Ok(Some(i));
        }
    }
    Ok(None)
}

// --------------------------------------------------------------------------- //
// 慢连接抢占换线（0.4.0 A 档）
//
// 参考 YunX「12KB/s 持续 15s 判定慢片、重连换线路」。FluxDL 的 segment_loop
// 原来只有「请求头 30s 超时」，连接建立后若某条线路只滴几 KB/s（甚至完全卡住
// 但不断流），既不会触发超时也不会重试，会一直拖到整体超时。这里用一个纯时间
// 窗口状态机：观测窗口内吞吐低于阈值且已过热身、且该分段还剩足够字节时，
// 主动断开本条连接、回到重试循环从当前 pos 重新 Range（换一条线路）。
//
// 关键防误判：任务级或全局限速开启时吞吐低是**人为**的，不能换线；分段快下完
// 时换线无意义；换线次数设上限，避免劣质链路无限重连。时间由调用方以 f64 秒
// 传入，状态机纯数据、可确定性单测。
// --------------------------------------------------------------------------- //

pub const STALL_WINDOW_SECS: f64 = 15.0;
pub const STALL_MIN_BPS: f64 = 12.0 * 1024.0;
pub const STALL_GRACE_SECS: f64 = 5.0;
pub const STALL_MAX_SWAPS: usize = 3;
pub const STALL_MIN_REMAIN: u64 = 256 * 1024;
/// 无 chunk 到达时的探测心跳间隔（秒），用于识别「完全不断流但零字节」的死连接。
pub const STALL_TICK_SECS: u64 = 1;

#[derive(Debug, Clone)]
pub struct StallWatch {
    connect_at: f64,
    window_at: f64,
    window_bytes: u64,
    swaps: usize,
}

impl StallWatch {
    pub fn new(now: f64) -> Self {
        Self {
            connect_at: now,
            window_at: now,
            window_bytes: 0,
            swaps: 0,
        }
    }

    /// 换线重连后调用：重置热身与窗口起点，但保留累计换线次数上限。
    pub fn on_reconnect(&mut self, now: f64) {
        self.connect_at = now;
        self.window_at = now;
        self.window_bytes = 0;
    }

    pub fn swaps(&self) -> usize {
        self.swaps
    }

    /// 一次观测：`chunk_bytes` 本事件新增字节，`remaining` 本分段剩余字节，
    /// `enabled` 表示是否允许换线（无主动限速）。返回 true = 应断开换线。
    ///
    /// 每次窗口到期都重置窗口（无论是否触发），保证「持续低吞吐」判定是滑动的，
    /// 不会被某个历史快窗口永久掩盖，也不会因一次慢窗口就反复触发。
    pub fn observe(
        &mut self,
        now: f64,
        chunk_bytes: u64,
        remaining: u64,
        enabled: bool,
    ) -> bool {
        self.window_bytes = self.window_bytes.saturating_add(chunk_bytes);
        let elapsed = now - self.window_at;
        if elapsed < STALL_WINDOW_SECS {
            return false;
        }
        let rate = self.window_bytes as f64 / elapsed.max(0.001);
        self.window_at = now;
        self.window_bytes = 0;
        let graced = now - self.connect_at >= STALL_GRACE_SECS;
        let worth = remaining >= STALL_MIN_REMAIN;
        if enabled && graced && worth && self.swaps < STALL_MAX_SWAPS && rate < STALL_MIN_BPS {
            self.swaps += 1;
            return true;
        }
        false
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

    // ---- 0.4.0 A 档：分片写后回读校验 ----

    fn write_test_region(file: &File, offset: u64, data: &[u8]) -> SegmentDigest {
        // write_at 内部循环写完整个 buf，返回 ()；直接一次写完再对同一批字节算摘要。
        let mut sink = DigestSink::new();
        write_at(file, data, offset).unwrap();
        sink.update(data);
        sink.finish(offset, offset + data.len() as u64)
    }

    #[test]
    fn digest_sink_matches_sha256_of_written_bytes() {
        // 摘要必须等于「网络流过的字节」的 SHA-256，长度/区间记录也要精确。
        let data = b"the quick brown fox jumps over the lazy dog";
        let mut sink = DigestSink::new();
        sink.update(&data[..20]);
        sink.update(&data[20..]);
        let d = sink.finish(100, 100 + data.len() as u64);
        assert_eq!(d.start, 100);
        assert_eq!(d.len, data.len() as u64);
        let expected: [u8; 32] = {
            use sha2::{Digest, Sha256};
            let out = Sha256::digest(data);
            let mut h = [0u8; 32];
            h.copy_from_slice(&out);
            h
        };
        assert_eq!(d.hash, expected);
    }

    #[test]
    fn verify_regions_accepts_intact_file() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let file = tmp.reopen().unwrap();
        file.set_len(4096).unwrap();
        let a = b"AAAAAAAAAAAAAAAA";
        let b = b"BBBBBBBBBBBBBBBB";
        let da = write_test_region(&file, 0, a);
        let db = write_test_region(&file, 2048, b);
        assert_eq!(verify_regions(&file, &[da, db]).unwrap(), None);
    }

    #[test]
    fn verify_regions_detects_zeroed_sparse_hole() {
        // 复现「长度对、内容是 0」：记录的是写过的字节，但磁盘上被补成 0。
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let file = tmp.reopen().unwrap();
        file.set_len(1024).unwrap();
        let data = b"REAL-CONTENT-HERE";
        let d = write_test_region(&file, 0, data);
        // 模拟稀疏空洞 / 覆盖：把落盘内容清零，但长度与记录完全一致。
        write_at(&file, &[0u8; 17], 0).unwrap();
        assert_eq!(verify_regions(&file, &[d]).unwrap(), Some(0));
    }

    #[test]
    fn verify_regions_skips_empty_digests() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let file = tmp.reopen().unwrap();
        let empty = SegmentDigest { start: 0, len: 0, hash: [0u8; 32] };
        assert_eq!(verify_regions(&file, &[empty]).unwrap(), None);
    }

    #[test]
    fn hash_region_respects_absolute_offset() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let file = tmp.reopen().unwrap();
        file.set_len(9000).unwrap();
        let data = b"offset-region-payload";
        write_at(&file, data, 4096).unwrap();
        let got = hash_region(&file, 4096, data.len() as u64).unwrap();
        let expected: [u8; 32] = {
            use sha2::{Digest, Sha256};
            let out = Sha256::digest(data);
            let mut h = [0u8; 32];
            h.copy_from_slice(&out);
            h
        };
        assert_eq!(got, expected, "回读必须从绝对偏移起，不受文件游标影响");
    }

    #[test]
    fn hash_region_errors_on_short_file() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let file = tmp.reopen().unwrap();
        // 请求读 100 字节但文件为空 → 回读提前结束，必须报错而不是判成一致。
        assert!(hash_region(&file, 0, 100).is_err());
    }

    // ---- 0.4.0 A 档：慢连接抢占换线 ----

    #[test]
    fn stall_watch_does_not_fire_before_window_or_grace() {
        let mut w = StallWatch::new(0.0);
        // 窗口未到期（< 15s）不判；即使完全零字节也不换线。
        assert!(!w.observe(10.0, 0, 10_000_000, true));
        assert_eq!(w.swaps(), 0);
    }

    #[test]
    fn stall_watch_fires_on_sustained_low_throughput() {
        let mut w = StallWatch::new(0.0);
        // 15s 窗口只收到 30KB（≈2KB/s < 12KB/s），且已过热身、剩余量大 → 换线。
        assert!(w.observe(15.0, 30_000, 10_000_000, true));
        assert_eq!(w.swaps(), 1);
    }

    #[test]
    fn stall_watch_fires_on_dead_connection_zero_bytes() {
        let mut w = StallWatch::new(0.0);
        // 心跳每秒 observe 一次零字节；到第 15s 窗口到期应判死连接换线。
        let mut fired = false;
        for t in 1..=20u64 {
            if w.observe(t as f64, 0, 10_000_000, true) {
                fired = true;
                break;
            }
        }
        assert!(fired, "完全不断流但零字节的死连接必须被换线");
    }

    #[test]
    fn stall_watch_healthy_connection_never_fires() {
        let mut w = StallWatch::new(0.0);
        let mut fired = false;
        for t in 1..=60u64 {
            // 每秒 1MB，远超阈值。
            if w.observe(t as f64, 1_048_576, 50_000_000, true) {
                fired = true;
            }
        }
        assert!(!fired);
        assert_eq!(w.swaps(), 0);
    }

    #[test]
    fn stall_watch_never_fires_when_rate_limited() {
        // 人为限速导致的低吞吐不能误判为「慢连接」。
        let mut w = StallWatch::new(0.0);
        for t in 1..=60u64 {
            assert!(!w.observe(t as f64, 1_000, 50_000_000, false));
        }
        assert_eq!(w.swaps(), 0);
    }

    #[test]
    fn stall_watch_ignores_almost_finished_segment() {
        // 分段只剩几 KB 时换线无意义（重连成本 > 收益）。
        let mut w = StallWatch::new(0.0);
        assert!(!w.observe(15.0, 0, 1024, true));
        assert_eq!(w.swaps(), 0);
    }

    #[test]
    fn stall_watch_caps_swaps_and_recovers_after_reconnect() {
        // 单调递增时间：每条新连接都要重新熬过热身(5s)+窗口(15s)才能再次换线。
        // 连续 6 段劣质链路，但换线次数不得超过 STALL_MAX_SWAPS。
        let mut w = StallWatch::new(0.0);
        let mut now = 0.0f64;
        let mut fired_total = 0;
        for _ in 0..6 {
            // 该连接持续 16s 零字节，期间每秒一次心跳观测。
            let mut fired_this_conn = false;
            for _ in 0..16 {
                now += 1.0;
                if w.observe(now, 0, 10_000_000, true) {
                    fired_this_conn = true;
                    break;
                }
            }
            if fired_this_conn {
                fired_total += 1;
                w.on_reconnect(now);
            }
        }
        assert!(fired_total > 0, "劣质链路应至少换线一次");
        assert_eq!(
            fired_total, STALL_MAX_SWAPS,
            "换线次数必须恰好封顶，防止无限重连"
        );
        assert_eq!(w.swaps(), STALL_MAX_SWAPS);
    }

    #[test]
    fn stall_watch_healthy_after_reconnect_resets_grace() {
        // 换线后立刻恢复健康，不应因为「历史慢窗口」继续被判换线。
        let mut w = StallWatch::new(0.0);
        assert!(w.observe(15.0, 0, 10_000_000, true));
        w.on_reconnect(15.0);
        let mut fired = false;
        for t in 16..=45u64 {
            if w.observe(t as f64, 2_000_000, 50_000_000, true) {
                fired = true;
            }
        }
        assert!(!fired, "重连后健康的连接不得再被误判");
        assert_eq!(w.swaps(), 1);
    }
}
