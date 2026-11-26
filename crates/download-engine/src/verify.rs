//! 阶段一 #4：校验与状态健壮性 —— 纯逻辑层。
//!
//! 三件事，全部做成不依赖 I/O 的纯函数，便于确定性单测：
//! 1. 解析服务器校验头 `Digest` / `Content-Digest` / `Content-MD5`，得到"服务器声明的期望摘要"。
//! 2. 区分「文件变了」（ETag/长度不符 → 重下）与「文件损坏」（hash 不符 → 只重取坏区间）。
//! 3. 由本次写盘摘要 + 回读结果，算出需要重取的坏区间集合。
//!
//! 设计纪律：HTTP 普遍**没有**校验头，没有期望值时行为与现状完全一致（不臆造校验）。
//! 只有服务器明确给了可解析的强摘要（sha-256）时，才把"内容真实性"纳入判定。

use base64::Engine as _;
use reqwest::header::HeaderMap;
use sha2::{Digest as _, Sha256};
use std::collections::BTreeSet;

/// 服务器声明的完整性期望（来自响应头）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrityExpectation {
    /// 算法标识（小写），目前支持 sha-256；md5 仅解析不强校验（弱算法）。
    pub algorithm: String,
    /// 解码后的摘要字节。
    pub digest: Vec<u8>,
}

/// 分类结果：决定"重下"还是"只重取坏区间"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntegrityVerdict {
    /// 没有可用的服务器期望摘要 → 保持现有写盘校验逻辑，不改变行为。
    Unavailable,
    /// 文件变了（ETag/长度/服务器摘要不符）→ 整份重下。
    RemoteChanged,
    /// 落盘损坏但资源未变 → 只重取这些绝对字节区间 [start, end)。
    Corrupt(BTreeSet<(u64, u64)>),
    /// 一切正常。
    Intact,
}

/// 解析 `Digest` / `Content-Digest` 头。RFC 9530 形如：
/// `sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:`（base64，冒号包裹）
/// 也兼容不带冒号的 base64 / 十六进制。多个用逗号分隔，取第一个可识别的 sha-256。
pub fn parse_digest_header(value: &str) -> Option<IntegrityExpectation> {
    for part in value.split(',') {
        let part = part.trim();
        let (alg, raw) = part.split_once('=')?;
        let alg = alg.trim().to_ascii_lowercase();
        if alg != "sha-256" {
            continue;
        }
        let raw = raw.trim().trim_matches(':');
        // 关键：base64 与 hex 的字符集合重叠（hex 全是合法 base64 字符），
        // 必须先解码再用「算法期望字节数」过滤，否则 64 字符的 hex 会被
        // base64 误解成 48 字节的垃圾值。sha-256 固定 32 字节，据此判定。
        const SHA256_LEN: usize = 32;
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) {
            if bytes.len() == SHA256_LEN {
                return Some(IntegrityExpectation {
                    algorithm: alg,
                    digest: bytes,
                });
            }
        }
        if let Ok(bytes) = hex_decode(raw) {
            if bytes.len() == SHA256_LEN {
                return Some(IntegrityExpectation {
                    algorithm: alg,
                    digest: bytes,
                });
            }
        }
    }
    None
}

/// 解析传统 `Content-MD5` 头（base64 编码的 16 字节摘要）。
pub fn parse_content_md5(value: &str) -> Option<IntegrityExpectation> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .ok()?;
    (bytes.len() == 16).then_some(IntegrityExpectation {
        algorithm: "md5".into(),
        digest: bytes,
    })
}

/// 从响应头里提取可用于**整文件**校验的 sha-256 期望摘要。
///
/// 关键语义（RFC 9530）：本引擎的 probe 发的是 `Range: bytes=0-0`，
/// - `Content-Digest` 描述的是「当前响应体」（对 206 就是这 1 个字节），
/// - 传统 `Digest` 在 Range 响应里语义模糊，
/// - 只有 `Repr-Digest` 恒定描述「整个资源的表示」，与 Range 无关。
///
/// 因此**只认 `Repr-Digest`**，否则会把 1 字节的摘要拿去校验整文件，
/// 误判所有带 `Content-Digest` 的下载为损坏。没有就返回 None（保持现状）。
pub fn expectation_from_headers(headers: &HeaderMap) -> Option<IntegrityExpectation> {
    if let Some(value) = headers
        .get("repr-digest")
        .and_then(|v| v.to_str().ok())
    {
        if let Some(exp) = parse_digest_header(value) {
            if exp.algorithm == "sha-256" {
                return Some(exp);
            }
        }
    }
    None
}

/// 计算字节切片的 sha-256（用于纯逻辑测试与文件校验对照）。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let out = Sha256::digest(bytes);
    hex_encode(&out)
}

/// 分类一次下载结果。
///
/// 参数语义：
/// - `expected`：服务器声明的期望摘要，None 表示服务器没给（走现状）。
/// - `actual_sha256`：本次收到的完整内容算出的 sha-256（32 字节）。
/// - `etag_changed`：远端 ETag 与历史续传 ETag 是否不一致。
/// - `length_changed`：远端长度与历史/磁盘 part 长度是否不一致。
/// - `corrupt_regions`：写盘回读校验定位到的坏区间（半开区间）。
///
/// 判定优先级：文件变了（远端证据）> 真实性不符（服务器摘要）> 落盘损坏（只重取坏区间）。
pub fn classify(
    expected: Option<&IntegrityExpectation>,
    actual_sha256: &[u8],
    etag_changed: bool,
    length_changed: bool,
    corrupt_regions: BTreeSet<(u64, u64)>,
) -> IntegrityVerdict {
    if etag_changed || length_changed {
        return IntegrityVerdict::RemoteChanged;
    }
    if let Some(exp) = expected {
        if exp.algorithm == "sha-256" && !exp.digest.is_empty() {
            if exp.digest.as_slice() != actual_sha256 {
                return IntegrityVerdict::RemoteChanged;
            }
            // 服务器摘要相符 = 内容真实性 OK；即便回读到坏区间，也不是"文件变了"，
            // 而是纯落盘问题 → 走只重取坏区间。
            return if corrupt_regions.is_empty() {
                IntegrityVerdict::Intact
            } else {
                IntegrityVerdict::Corrupt(corrupt_regions)
            };
        }
    }
    // 没有服务器摘要：退化为现有写盘校验语义。
    if corrupt_regions.is_empty() {
        IntegrityVerdict::Intact
    } else {
        IntegrityVerdict::Corrupt(corrupt_regions)
    }
}

/// 断点续传资格判定（纯函数，不依赖 I/O）。
///
/// 背景：旧实现把续传的必要条件写成「服务器必须返回强 ETag 且与历史一致」。
/// 大量 CDN / 带签名参数的直链要么不带 ETag，要么每次请求 ETag 都变，
/// 于是这些任务一旦中断，点击恢复/重试就会清空分段与 part 从头下载——
/// 这正是「断掉后很难恢复下载」的根因。
///
/// 新的判定把 ETag 从「必要条件」降级为「充分条件之一」：
/// - 强 ETag 一致 → 直接续传（最可靠，行为不变）；
/// - 强 ETag 明确不一致 / 长度变了 → 远端文件已变，必须全量重下；
/// - 没有 ETag（或只有弱 ETag）但本地 part 完好 → 不直接相信，也不直接丢弃，
///   而是返回 `Probe`，要求调用方做重叠字节校验（取 part 已下载区域的尾部区间，
///   向服务器请求同一区间比对）。一致才续传，不一致全量重下。
///
/// 这样既恢复了「无 ETag 链接也能续传」，又用重叠校验堵住了
/// 「同长度但内容已变 → 续传拼出损坏文件」的风险（对标 MDM 的 overlap check）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeDecision {
    /// 全量重下：不支持 Range / 长度不符 / 无进度 / 无有效分段 / ETag 明确变化。
    Restart,
    /// 强 ETag 一致，可直接续传，无需额外探测。
    Strict,
    /// ETag 不可用，但本地 part 可续；须做重叠字节校验后再定。
    Probe,
}

/// 纯判定：`ranges` 服务器支持 Range、`total` 远端总长、`stored_total` 历史总长、
/// `probe_etag` 本次探测到的强 ETag、`stored_etag` 历史强 ETag、
/// `prev_bytes` 已下载字节、`has_segments` 是否有有效分段快照、`part_complete`
/// 本地 part 是否真实存在且长度等于 total（由调用方用元数据判定）。
pub fn resume_decision(
    ranges: bool,
    total: u64,
    stored_total: u64,
    probe_etag: Option<&str>,
    stored_etag: Option<&str>,
    prev_bytes: u64,
    has_segments: bool,
    part_complete: bool,
) -> ResumeDecision {
    // 无法续传的硬前提：不支持 Range / 长度为 0 / 远端与历史长度不一致 /
    // 没有任何进度 / 没有分段快照 / part 文件不完整。
    if !ranges || total == 0 || stored_total != total || prev_bytes == 0 || !has_segments {
        return ResumeDecision::Restart;
    }
    match (probe_etag, stored_etag) {
        // 两边都有强 ETag：一致才续传，变化则远端文件已变，全量重下。
        (Some(p), Some(s)) => {
            if p == s {
                ResumeDecision::Strict
            } else {
                ResumeDecision::Restart
            }
        }
        // 任一侧没有强 ETag：不能凭长度相信内容，交给重叠校验裁决。
        _ => {
            if part_complete {
                ResumeDecision::Probe
            } else {
                ResumeDecision::Restart
            }
        }
    }
}

/// 十六进制解码（仅 a-fA-F0-9）。
fn hex_decode(s: &str) -> Result<Vec<u8>, ()> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return Err(());
    }
    let mut out = Vec::with_capacity(b.len() / 2);
    for pair in b.chunks(2) {
        let hi = (pair[0] as char).to_digit(16).ok_or(())?;
        let lo = (pair[1] as char).to_digit(16).ok_or(())?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rfc9530_base64_colon_form() {
        // "hello" 的 sha-256 base64（RFC 9530 冒号包裹写法）
        let b64 = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(b"hello"));
        let header = format!("sha-256=:{b64}:");
        let exp = parse_digest_header(&header).expect("应解析成功");
        assert_eq!(exp.algorithm, "sha-256");
        assert_eq!(exp.digest.as_slice(), &Sha256::digest(b"hello")[..]);
    }

    #[test]
    fn parse_digest_hex_and_multiple_algorithms() {
        let hex = hex_encode(&Sha256::digest(b"abc"));
        let header = format!("md5=deadbeef, sha-256={hex}");
        let exp = parse_digest_header(&header).expect("应取到 sha-256");
        assert_eq!(exp.algorithm, "sha-256");
        assert_eq!(exp.digest.as_slice(), &Sha256::digest(b"abc")[..]);
    }

    #[test]
    fn parse_digest_skips_unknown_and_malformed() {
        assert!(parse_digest_header("crc32=1234").is_none());
        assert!(parse_digest_header("garbage").is_none());
        assert!(parse_digest_header("").is_none());
    }

    #[test]
    fn parse_content_md5_length_guard() {
        let md5 = base64::engine::general_purpose::STANDARD.encode([0u8; 16]);
        let exp = parse_content_md5(&md5).expect("16 字节应解析");
        assert_eq!(exp.algorithm, "md5");
        assert!(parse_content_md5("YWJj").is_none()); // "abc" 只有 3 字节，非 16
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // 标准测试向量：abc
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn sample_exp(data: &[u8]) -> IntegrityExpectation {
        IntegrityExpectation {
            algorithm: "sha-256".into(),
            digest: Sha256::digest(data).to_vec(),
        }
    }

    #[test]
    fn headers_only_accept_repr_digest_not_content_digest() {
        // probe 的 Range:0-0 响应里 Content-Digest 是那 1 字节的摘要，绝不能当整文件期望。
        let mut headers = HeaderMap::new();
        let one_byte = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(b"x"));
        let whole = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(b"whole-file"));
        headers.insert(
            "content-digest",
            format!("sha-256=:{one_byte}:").parse().unwrap(),
        );
        assert!(expectation_from_headers(&headers).is_none());

        headers.insert("repr-digest", format!("sha-256=:{whole}:").parse().unwrap());
        let exp = expectation_from_headers(&headers).expect("应取到 Repr-Digest");
        assert_eq!(exp.digest.as_slice(), &Sha256::digest(b"whole-file")[..]);
    }

    #[test]
    fn classify_no_expectation_falls_back_to_corrupt_regions() {
        let mut bad = BTreeSet::new();
        bad.insert((10, 20));
        let v = classify(None, &[], false, false, bad.clone());
        assert_eq!(v, IntegrityVerdict::Corrupt(bad));
        assert_eq!(
            classify(None, &[], false, false, BTreeSet::new()),
            IntegrityVerdict::Intact
        );
    }

    #[test]
    fn classify_etag_or_length_change_wins() {
        let exp = sample_exp(b"content");
        let actual = &Sha256::digest(b"content")[..];
        let bad = BTreeSet::new();
        assert_eq!(
            classify(Some(&exp), actual, true, false, bad.clone()),
            IntegrityVerdict::RemoteChanged
        );
        assert_eq!(
            classify(Some(&exp), actual, false, true, bad),
            IntegrityVerdict::RemoteChanged
        );
    }

    #[test]
    fn classify_server_digest_mismatch_is_remote_changed() {
        let exp = sample_exp(b"expected");
        let actual = &Sha256::digest(b"different")[..];
        let mut bad = BTreeSet::new();
        bad.insert((0, 8));
        assert_eq!(
            classify(Some(&exp), actual, false, false, bad),
            IntegrityVerdict::RemoteChanged
        );
    }

    #[test]
    fn classify_digest_ok_but_disk_corrupt_only_refetches_bad() {
        let exp = sample_exp(b"content");
        let actual = &Sha256::digest(b"content")[..];
        let mut bad = BTreeSet::new();
        bad.insert((100, 200));
        bad.insert((300, 400));
        assert_eq!(
            classify(Some(&exp), actual, false, false, bad.clone()),
            IntegrityVerdict::Corrupt(bad)
        );
    }

    #[test]
    fn classify_all_intact() {
        let exp = sample_exp(b"content");
        let actual = &Sha256::digest(b"content")[..];
        assert_eq!(
            classify(Some(&exp), actual, false, false, BTreeSet::new()),
            IntegrityVerdict::Intact
        );
    }

    // ---- 续传资格判定 ----

    #[test]
    fn resume_etag_match_is_strict() {
        assert_eq!(
            resume_decision(true, 1000, 1000, Some("\"v1\""), Some("\"v1\""), 400, true, true),
            ResumeDecision::Strict
        );
    }

    #[test]
    fn resume_etag_changed_restarts_even_if_part_ok() {
        // ETag 明确变化 = 远端文件已换，即便长度和 part 都一致也必须全量重下。
        assert_eq!(
            resume_decision(true, 1000, 1000, Some("\"v2\""), Some("\"v1\""), 400, true, true),
            ResumeDecision::Restart
        );
    }

    #[test]
    fn resume_without_etag_probes_when_part_complete() {
        // 本轮修复的核心：无 ETag 不再一律从头，而是进入重叠校验。
        assert_eq!(
            resume_decision(true, 1000, 1000, None, None, 400, true, true),
            ResumeDecision::Probe
        );
        // 一侧有、一侧无，同样走探测。
        assert_eq!(
            resume_decision(true, 1000, 1000, Some("\"v1\""), None, 400, true, true),
            ResumeDecision::Probe
        );
    }

    #[test]
    fn resume_without_etag_restarts_when_part_incomplete() {
        // part 不完整（缺失或长度不符）→ 不能跳过分段，必须从头。
        assert_eq!(
            resume_decision(true, 1000, 1000, None, None, 400, true, false),
            ResumeDecision::Restart
        );
    }

    #[test]
    fn resume_hard_preconditions_restart() {
        // 不支持 Range。
        assert_eq!(
            resume_decision(false, 1000, 1000, None, None, 400, true, true),
            ResumeDecision::Restart
        );
        // 远端长度为 0。
        assert_eq!(
            resume_decision(true, 0, 0, None, None, 0, true, true),
            ResumeDecision::Restart
        );
        // 长度与历史不符。
        assert_eq!(
            resume_decision(true, 1000, 900, None, None, 400, true, true),
            ResumeDecision::Restart
        );
        // 没有任何进度。
        assert_eq!(
            resume_decision(true, 1000, 1000, None, None, 0, true, true),
            ResumeDecision::Restart
        );
        // 没有分段快照。
        assert_eq!(
            resume_decision(true, 1000, 1000, None, None, 400, false, true),
            ResumeDecision::Restart
        );
    }
}
