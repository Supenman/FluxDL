//! 网页批量抓链器（Link Grabber，参考 MDM `html.rs` / `folder.rs`，零新增外部依赖）：
//!
//! 抓取任意网页（如 Apache/Nginx `Index of /` 目录索引页、软件/数据集发布页）中的
//! `<a href="...">` 链接，解析为绝对 http(s) URL，去重、剔除导航与锚点噪声，并按
//! 扩展名提取文件名与分类，供前端弹窗筛选勾选后批量入队。

use crate::manager::EngineError;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;
use url::Url;

const MAX_HTML_BYTES: usize = 4 * 1024 * 1024;
const MAX_GRABBED_LINKS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabbedLink {
    pub url: String,
    pub filename: String,
    pub ext: String,
    pub likely_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabResult {
    pub page_url: String,
    pub title: String,
    pub links: Vec<GrabbedLink>,
}

/// 常见可下载文件扩展名（优先排在前面方便一键勾选）。
const FILE_EXTS: &[&str] = &[
    "zip", "7z", "rar", "tar", "gz", "tgz", "xz", "bz2", "zst", "iso", "img",
    "exe", "msi", "dmg", "pkg", "deb", "rpm", "appimage", "apk",
    "mp4", "mkv", "webm", "mov", "avi", "flv", "mp3", "flac", "wav", "m4a", "ogg",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub", "txt", "csv", "json", "xml",
    "safetensors", "gguf", "bin", "pt", "pth", "onnx", "ckpt", "parquet",
    "png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "psd",
];

fn extract_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else {
        return String::new();
    };
    let Some(gt) = lower[start..].find('>') else {
        return String::new();
    };
    let content_start = start + gt + 1;
    let Some(end_rel) = lower[content_start..].find("</title>") else {
        return String::new();
    };
    html[content_start..content_start + end_rel]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 纯函数：从 HTML 源码中提取去重后的绝对链接清单（便于无网络单测）。
pub fn extract_links_from_html(base_url: &Url, html: &str) -> GrabResult {
    let title = extract_title(html);
    let mut seen = HashSet::new();
    let mut links = Vec::new();

    let bytes = html.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && links.len() < MAX_GRABBED_LINKS {
        // 寻找 `href=`（不区分大小写）
        if bytes[i] == b'h' || bytes[i] == b'H' {
            if i + 5 <= bytes.len() && html[i..i + 5].eq_ignore_ascii_case("href=") {
                let mut j = i + 5;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j >= bytes.len() {
                    break;
                }
                let quote = bytes[j];
                let (raw_href, next_pos) = if quote == b'"' || quote == b'\'' {
                    let start = j + 1;
                    let mut end = start;
                    while end < bytes.len() && bytes[end] != quote {
                        end += 1;
                    }
                    (&html[start..end], end.saturating_add(1))
                } else {
                    let start = j;
                    let mut end = start;
                    while end < bytes.len()
                        && !bytes[end].is_ascii_whitespace()
                        && bytes[end] != b'>'
                    {
                        end += 1;
                    }
                    (&html[start..end], end)
                };
                i = next_pos;

                let trimmed = raw_href.trim().replace("&amp;", "&");
                if trimmed.is_empty()
                    || trimmed.starts_with('#')
                    || trimmed.starts_with("javascript:")
                    || trimmed.starts_with("mailto:")
                    || trimmed.starts_with("tel:")
                    || trimmed == "../"
                    || trimmed == "./"
                {
                    continue;
                }

                let Ok(mut resolved) = base_url.join(&trimmed) else {
                    continue;
                };
                if !matches!(resolved.scheme(), "http" | "https") {
                    continue;
                }
                resolved.set_fragment(None);
                let url_str = resolved.to_string();
                // 跳过指向当前页或父级目录的链接
                if url_str == base_url.as_str() || url_str.ends_with('/') {
                    continue;
                }
                if !seen.insert(url_str.clone()) {
                    continue;
                }

                let filename = crate::util::filename_from_url(&resolved)
                    .unwrap_or_else(|| "file".to_string());
                let ext = std::path::Path::new(&filename)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let likely_file = !ext.is_empty() && FILE_EXTS.contains(&ext.as_str());

                links.push(GrabbedLink {
                    url: url_str,
                    filename,
                    ext,
                    likely_file,
                });
                continue;
            }
        }
        i += 1;
    }

    // 文件类链接排在前面，方便一眼勾选下载
    links.sort_by(|a, b| {
        b.likely_file
            .cmp(&a.likely_file)
            .then_with(|| a.filename.cmp(&b.filename))
    });

    GrabResult {
        page_url: base_url.to_string(),
        title,
        links,
    }
}

pub async fn grab_page_links(
    raw_url: &str,
    user_agent: &str,
    proxy: Option<&str>,
    use_system_proxy: bool,
) -> Result<GrabResult, EngineError> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|_| EngineError::message("请输入有效的 http:// 或 https:// 网页地址"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(EngineError::message("仅支持抓取 http:// 或 https:// 页面"));
    }

    let mut builder = Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .dns_resolver(crate::dns::shared_resolver());
    if let Some(p) = proxy.filter(|s| !s.trim().is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(p.trim())?);
    } else if !use_system_proxy {
        builder = builder.no_proxy();
    }
    let client = builder.build()?;

    let resp = client.get(parsed.as_str()).send().await?;
    if !resp.status().is_success() {
        return Err(EngineError::message(format!(
            "获取页面失败：HTTP {}",
            resp.status().as_u16()
        )));
    }
    let final_url = resp.url().clone();
    let bytes = resp.bytes().await?;
    let limited = if bytes.len() > MAX_HTML_BYTES {
        &bytes[..MAX_HTML_BYTES]
    } else {
        &bytes[..]
    };
    let html = String::from_utf8_lossy(limited);
    Ok(extract_links_from_html(&final_url, &html))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_prioritizes_downloadable_files() {
        let base = Url::parse("https://mirror.example.com/pub/").unwrap();
        let html = r#"
            <html><head><title>Index of /pub/</title></head>
            <body>
              <a href="../">Parent Directory</a>
              <a href="sub/">sub/</a>
              <a href="readme.html">readme</a>
              <a href="app-1.0.zip">app-1.0.zip</a>
              <a href="model.safetensors">model.safetensors</a>
              <a href="javascript:void(0)">noop</a>
            </body></html>
        "#;
        let res = extract_links_from_html(&base, html);
        assert_eq!(res.title, "Index of /pub/");
        assert_eq!(res.links.len(), 3);
        assert!(res.links[0].likely_file);
        assert!(res.links[1].likely_file);
        assert!(!res.links[2].likely_file);
        assert_eq!(res.links[0].filename, "app-1.0.zip");
        assert_eq!(res.links[1].filename, "model.safetensors");
    }
}
