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
    let mut candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
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
    for i in 1..1000 {
        let name = format!("{stem} ({i}){ext}");
        candidate = dir.join(name);
        if !candidate.exists() {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
