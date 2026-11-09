//! 抖音免 Cookie 直链解析。
//!
//! ## 为什么不用 PC Web 接口
//!
//! `www.douyin.com/aweme/v1/web/aweme/detail/` 位于字节跳动 Argus 风控网关后，
//! 缺 `a_bogus` / `uifid` / `x-secsdk-web-signature` 时一律 403
//! （`Blocked by ArgusSecurityPlugin Uifid Not Found`）。随包 yt-dlp 的 Douyin
//! 提取器不会生成这些签名，Cookie 也不足以通过 —— 这正是 0.3.9 B 档真机失败的根因。
//!
//! ## 本模块的做法
//!
//! 改用移动端老接口 `api.amemv.com/aweme/v1/aweme/detail/`：它不在 Argus 网关后，
//! 只要一个移动端 User-Agent，**不需要 Cookie、不需要登录、不需要任何签名**。
//! 响应的 `aweme_detail.video.play_addr.url_list` 就是无水印正片 CDN 直链。
//! 参考开源项目 `jiuhunwl/short_videos`（MIT）确认了接口形态，本文件为独立实现，
//! 不复制其代码、不读取本机凭证、不逆向签名。
//!
//! ## 可靠性边界
//!
//! 这是站点未公开接口而非官方 API，随时可能变更；部分作品会返回
//! `filter_reason=core_dep`（删除 / 私密 / 风控）。`Engine::add` 只在解析成功时
//! 把任务转成 HTTP 直链下载，失败时给出可操作指引，绝不创建必然失败的任务。
//! CDN 有防盗链，下载须带 `Referer: https://www.douyin.com/`（由 `Engine::add` 设置）。

use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::{Client, Proxy};
use std::time::Duration;
use url::Url;

/// 免 Cookie 详情接口。参数与移动端老客户端一致，`aid=6383` 是抖音的 app id。
const DETAIL_ENDPOINT: &str = "https://api.amemv.com/aweme/v1/aweme/detail/";

/// 详情接口专用移动端 UA（不含任何凭证）。
const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 13; 2210132C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36";

/// 短链跳转与 CDN 下载用的桌面 UA。CDN 对下载请求同样会看 UA。
pub const DOWNLOAD_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

/// 抖音 CDN 防盗链要求的来源页。
pub const REFERER: &str = "https://www.douyin.com/";

/// 解析结果：一个可直接交给 A 档 HTTP 引擎下载的无水印直链。
#[derive(Debug, Clone)]
pub struct ResolvedVideo {
    pub url: String,
    pub title: String,
    pub author: String,
}

impl ResolvedVideo {
    /// 建议文件名：「标题 - 作者.mp4」。清洗掉 Windows 非法字符、控制字符与
    /// 抖音标题里常见的 `#话题` 分隔符，标题为空时退回固定名，绝不让 CDN 直链里
    /// 的一长串参数进入文件名。
    pub fn suggested_filename(&self) -> String {
        let title = clean_name(&self.title, 70);
        if title.is_empty() {
            return "抖音视频.mp4".to_string();
        }
        let author = clean_name(&self.author, 24);
        if author.is_empty() {
            format!("{title}.mp4")
        } else {
            format!("{title} - {author}.mp4")
        }
    }
}

/// 生成建议文件名时的字符清洗：控制字符、Windows 保留字符，以及抖音标题里
/// 常见的 `#话题` 分隔符一律换成空格，避免标签 / 非法字符混进文件名。
fn clean_name(s: &str, limit: usize) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_control()
            || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#')
        {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    let joined = out.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(limit).collect::<String>().trim().to_string()
}

/// 是否为「抖音作品页面」链接（需要走解析），而非 CDN 直链或其它站点。
///
/// `douyinvod.com` / `douyinstatic.com` 这类 CDN 域名不以 `.douyin.com` 结尾，
/// 天然被排除；已带容器扩展名的 URL 也直接排除，避免把直链当成页面重新解析。
pub fn is_douyin_page(url: &str) -> bool {
    if crate::media::is_direct_media_file(url) {
        return false;
    }
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    host == "douyin.com"
        || host == "iesdouyin.com"
        || host.ends_with(".douyin.com")
        || host.ends_with(".iesdouyin.com")
}

/// aweme_id 形态：首位非 0 的 16~20 位纯数字（与上游接口校验一致）。
fn is_aweme_id(s: &str) -> bool {
    let b = s.as_bytes();
    (16..=20).contains(&b.len()) && b[0] != b'0' && b.iter().all(u8::is_ascii_digit)
}

/// 从详情页 / 分享页 URL 里提取作品 ID。短链（v.douyin.com/xxxx）没有数字 id，
/// 返回 None，由调用方先跟随 302 再提取。
pub fn extract_aweme_id(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    for (k, v) in parsed.query_pairs() {
        if k == "modal_id" && is_aweme_id(&v) {
            return Some(v.into_owned());
        }
    }
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|it| it.filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    // 倒数两段足够覆盖 /video/<id>、/share/video/<id>、/note/<id>。
    for seg in segments.iter().rev().take(2) {
        let t = seg.strip_suffix(".html").unwrap_or(seg);
        if is_aweme_id(t) {
            return Some(t.to_string());
        }
    }
    None
}

/// 在 URL 未带 `mime_type` 时补 `video_mp4`，便于播放器 / 下载器识别为 MP4。
///
/// 这里刻意用字符串拼接而不是 `Url` 重写：直链 query 里的签名参数含 `%2F`、
/// `%3D` 等编码，重新序列化可能改变字节导致 CDN 403。
fn ensure_mime_type(url: &str) -> String {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    let query = query.split('#').next().unwrap_or("");
    if query.split('&').any(|kv| kv.starts_with("mime_type=")) {
        return url.to_string();
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}mime_type=video_mp4")
}

fn build_client(proxy: Option<&str>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent(DOWNLOAD_UA)
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(6));
    if let Some(p) = proxy.map(str::trim).filter(|s| !s.is_empty()) {
        builder = builder.proxy(
            Proxy::all(p).map_err(|e| format!("代理地址无效：{e}"))?,
        );
    }
    builder
        .build()
        .map_err(|e| format!("创建解析请求客户端失败：{e}"))
}

/// 短链跟随 302 后的最终地址。实测 `v.douyin.com/i5u48YTn/` →
/// `www.iesdouyin.com/share/video/<aweme_id>/?...`。
async fn resolve_short_link(client: &Client, url: &str) -> Result<String, String> {
    let resp = client
        .get(url)
        .header(USER_AGENT, DOWNLOAD_UA)
        .send()
        .await
        .map_err(|e| format!("抖音短链跳转失败（{e}）。请检查网络或代理，或改用视频详情页链接"))?;
    Ok(resp.url().to_string())
}

/// 解析一个抖音作品页面链接，返回无水印直链。
///
/// `proxy` 来自引擎全局设置；不读取任何浏览器 Cookie / 登录态。
pub async fn resolve(page_url: &str, proxy: Option<&str>) -> Result<ResolvedVideo, String> {
    let client = build_client(proxy)?;

    let mut id = extract_aweme_id(page_url);
    if id.is_none() {
        // v.douyin.com 短链、或链接里没有可直接读取的数字 id。
        let final_url = resolve_short_link(&client, page_url).await?;
        id = extract_aweme_id(&final_url);
    }
    let id = id.ok_or_else(|| {
        "未能从链接中识别作品 ID。请复制「单个视频」的详情页链接或分享短链，不要使用首页 / 合集 / 个人主页链接".to_string()
    })?;

    let detail_url = format!(
        "{DETAIL_ENDPOINT}?aweme_id={id}&aid=6383&device_platform=web&version_code=190500&version_name=19.5.0"
    );
    let resp = client
        .get(&detail_url)
        .header(USER_AGENT, MOBILE_UA)
        .header(ACCEPT, "application/json, text/plain, */*")
        .send()
        .await
        .map_err(|e| {
            format!("抖音解析请求失败（{e}）。请检查网络或代理设置；也可用扩展「本页资源」里嗅探到的视频直链下载")
        })?;
    if !resp.status().is_success() {
        return Err(format!(
            "抖音解析接口返回 HTTP {}；请稍后重试，或用扩展「本页资源」里的视频直链",
            resp.status()
        ));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取抖音解析响应失败（{e}）"))?;
    parse_detail(&body, &id)
}

/// 纯函数解析详情响应，便于单测覆盖成功 / 风控 / 图集三类分支。
fn parse_detail(body: &str, expected_id: &str) -> Result<ResolvedVideo, String> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "抖音解析接口返回内容不是有效 JSON".to_string())?;
    if json.get("status_code").and_then(|v| v.as_i64()) != Some(0) {
        return Err("抖音解析接口未返回成功状态，请稍后重试".to_string());
    }
    let detail = json.get("aweme_detail").filter(|v| v.is_object()).ok_or_else(|| {
        let reason = json
            .pointer("/filter_detail/filter_reason")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if reason == "core_dep" {
            "该视频暂时无法解析（可能已删除、设为私密或被平台风控）。请稍后重试，或用扩展「本页资源」里嗅探到的视频直链下载".to_string()
        } else {
            "抖音解析接口没有返回视频详情。请稍后重试，或用扩展「本页资源」里的视频直链".to_string()
        }
    })?;

    // ID 不匹配多半是上游返回了兜底内容，不能把别的视频下给用户。
    if let Some(got) = detail.get("aweme_id").and_then(|v| v.as_str()) {
        if got != expected_id {
            return Err("抖音解析接口返回的作品 ID 与链接不一致，请重试".to_string());
        }
    }

    let url = play_url(detail).ok_or_else(|| {
        "该作品是图集 / 实况或多视频，当前仅支持单个视频下载；请用扩展「本页资源」里的直链".to_string()
    })?;

    let title = detail
        .get("desc")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let author = detail
        .pointer("/author/nickname")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(ResolvedVideo {
        url: ensure_mime_type(&url),
        title,
        author,
    })
}

/// 优先取 `play_addr.url_list` 的无水印正片；缺失时退回 `bit_rate_list` 首档。
/// 只接受 https，跳过 `playwm`（带水印）地址。
fn play_url(detail: &serde_json::Value) -> Option<String> {
    let pick = |v: &serde_json::Value| -> Option<String> {
        v.get("url_list")
            .and_then(|v| v.as_array())?
            .iter()
            .filter_map(|v| v.as_str())
            .find(|u| u.starts_with("https://") && !u.contains("playwm"))
            .map(str::to_string)
    };
    if let Some(u) = detail.pointer("/video/play_addr").and_then(pick) {
        return Some(u);
    }
    detail
        .pointer("/video/bit_rate_list")
        .and_then(|v| v.as_array())
        .and_then(|list| list.iter().find_map(|item| item.get("play_addr").and_then(pick)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_douyin_pages_are_parsed() {
        for url in [
            "https://www.douyin.com/video/7685345542323834441",
            "https://www.douyin.com/jingxuan?modal_id=7702008165390421263",
            "https://v.douyin.com/i5u48YTn/",
            "https://www.iesdouyin.com/share/video/7477518093946752310/",
            "https://www.douyin.com/note/7604472147116556322",
        ] {
            assert!(is_douyin_page(url), "应识别为抖音页面：{url}");
        }
        for url in [
            "https://v26-web.douyinvod.com/video/tos/abc?a=1",
            "https://sf11-cdn-tos.douyinstatic.com/obj/a.mp3",
            "https://www.bilibili.com/video/BV1GysQ6hEgB",
            "https://www.kuaishou.com/short-video/3xabc",
            "https://cdn.douyin.com/x/y.mp4?token=1",
            "https://example.com/douyin.com/video/123",
            "not a url",
        ] {
            assert!(!is_douyin_page(url), "不应识别为抖音页面：{url}");
        }
    }

    #[test]
    fn extracts_aweme_id_from_all_link_shapes() {
        let cases = [
            ("https://www.douyin.com/video/7685345542323834441", "7685345542323834441"),
            ("https://www.iesdouyin.com/share/video/7477518093946752310/?from_ssr=1", "7477518093946752310"),
            ("https://www.douyin.com/jingxuan?modal_id=7702008165390421263", "7702008165390421263"),
            ("https://www.douyin.com/note/7604472147116556322.html", "7604472147116556322"),
            ("https://www.douyin.com/user/MS4wLjABAAAA?modal_id=1234567890123456", "1234567890123456"),
        ];
        for (url, id) in cases {
            assert_eq!(extract_aweme_id(url).as_deref(), Some(id), "链接：{url}");
        }
        assert_eq!(extract_aweme_id("https://v.douyin.com/i5u48YTn/"), None);
        assert_eq!(extract_aweme_id("https://www.douyin.com/jingxuan"), None);
        // 合集 mix_id / 非法 id / 非数字都不该被当成作品 id
        assert_eq!(extract_aweme_id("https://www.douyin.com/jingxuan?modal_id=abc"), None);
        assert_eq!(extract_aweme_id("https://www.douyin.com/video/0123456789012345678"), None);
    }

    #[test]
    fn mime_type_is_appended_once_without_rewriting_signature() {
        let cdn = "https://v26-web.douyinvod.com/abc/video/tos/?a=6383&rc=abc%3D%3D";
        let once = ensure_mime_type(cdn);
        assert!(once.ends_with("&mime_type=video_mp4"));
        assert!(once.contains("rc=abc%3D%3D"), "不得改写已有签名参数的编码");
        assert_eq!(ensure_mime_type(&once), once, "已有 mime_type 不应重复追加");
        let already = "https://cdn.example/a?mime_type=video_mp4&x=1";
        assert_eq!(ensure_mime_type(already), already);
        assert_eq!(ensure_mime_type("https://cdn.example/a"), "https://cdn.example/a?mime_type=video_mp4");
    }

    #[test]
    fn suggested_filename_is_clean_and_bounded() {
        let v = ResolvedVideo {
            url: "https://cdn.example/a".into(),
            title: "信我！小个子闭眼冲 <这种> 8cm 的? #穿搭".into(),
            author: "某某|博主".into(),
        };
        let name = v.suggested_filename();
        assert!(name.ends_with(".mp4"));
        assert!(name.contains(" - "));
        assert!(!name.contains('<') && !name.contains('>') && !name.contains('|'));
        assert!(!name.contains('?') && !name.contains('#'));
        assert!(name.chars().count() <= 110, "文件名不应无限长：{name}");

        let empty = ResolvedVideo { url: String::new(), title: "  ".into(), author: String::new() };
        assert_eq!(empty.suggested_filename(), "抖音视频.mp4");
    }

    /// 真实接口响应形态（字段精简，保留关键路径）。
    fn detail_json(desc: &str, play: &serde_json::Value) -> String {
        serde_json::json!({
            "status_code": 0,
            "aweme_detail": {
                "aweme_id": "7685345542323834441",
                "desc": desc,
                "author": { "nickname": "测试作者" },
                "video": { "play_addr": play }
            }
        })
        .to_string()
    }

    #[test]
    fn parses_real_shaped_detail_response() {
        let play = serde_json::json!({
            "uri": "v0200fg10000dajt9cvog65rva8pg1ag",
            "url_list": [
                "https://v26-web.douyinvod.com/abc/video/tos/?a=6383&br=2029",
                "https://v3-web.douyinvod.com/abc/video/tos/?a=6383"
            ]
        });
        let got = parse_detail(&detail_json("小个子穿搭 #踩屎感", &play), "7685345542323834441").unwrap();
        assert!(got.url.contains("v26-web.douyinvod.com"));
        assert!(got.url.ends_with("&mime_type=video_mp4"));
        assert_eq!(got.title, "小个子穿搭 #踩屎感");
        assert_eq!(got.author, "测试作者");
        assert!(got.suggested_filename().starts_with("小个子穿搭"));
    }

    #[test]
    fn skips_watermarked_and_non_https_urls() {
        let play = serde_json::json!({
            "url_list": [
                "http://aweme.snssdk.com/playwm/?video_id=x",
                "https://v26-web.douyinvod.com/abc/video/tos/?a=6383"
            ]
        });
        let got = parse_detail(&detail_json("标题", &play), "7685345542323834441").unwrap();
        assert!(got.url.starts_with("https://v26-web.douyinvod.com"));
        assert!(!got.url.contains("playwm"));
    }

    #[test]
    fn falls_back_to_bit_rate_list() {
        let json = serde_json::json!({
            "status_code": 0,
            "aweme_detail": {
                "aweme_id": "7685345542323834441",
                "desc": "备用档位",
                "author": { "nickname": "作者" },
                "video": {
                    "play_addr": { "url_list": [] },
                    "bit_rate_list": [
                        { "play_addr": { "url_list": ["https://cdn.example/1080.mp4"] } }
                    ]
                }
            }
        })
        .to_string();
        let got = parse_detail(&json, "7685345542323834441").unwrap();
        assert!(got.url.contains("cdn.example/1080.mp4"));
    }

    #[test]
    fn core_dep_and_image_posts_give_actionable_errors() {
        let filtered = r#"{"status_code":0,"filter_detail":{"filter_reason":"core_dep","aweme_id":"7685345542323834441"}}"#;
        let err = parse_detail(filtered, "7685345542323834441").unwrap_err();
        assert!(err.contains("暂时无法解析"), "{err}");
        assert!(err.contains("本页资源"), "应给出可操作路径：{err}");

        let image = serde_json::json!({
            "status_code": 0,
            "aweme_detail": { "aweme_id": "7685345542323834441", "desc": "图集", "images": [] }
        })
        .to_string();
        let err = parse_detail(&image, "7685345542323834441").unwrap_err();
        assert!(err.contains("图集"), "{err}");

        assert!(parse_detail("not json", "7685345542323834441").is_err());
    }

    #[test]
    fn mismatched_id_is_rejected() {
        let play = serde_json::json!({ "url_list": ["https://cdn.example/a.mp4"] });
        let err = parse_detail(&detail_json("标题", &play), "7999999999999999999").unwrap_err();
        assert!(err.contains("不一致"), "{err}");
    }
}
