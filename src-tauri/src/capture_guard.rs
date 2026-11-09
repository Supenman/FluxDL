//! 本地捕获服务的请求准入检查。
//!
//! 独立成模块是为了不依赖 Tauri / WebView，可以直接用 `rustc --test` 验证。
//! 端口和令牌按项目约定保持不变，因此安全性只能靠 Host + Origin 校验来兜底。

use std::collections::HashMap;

pub const CAPTURE_PORT: u16 = 35917;

/// 允许访问本地服务的请求来源。
///
/// 令牌 `fluxdl-local-v1` 写在扩展源码里，属于公开值，单靠它挡不住网页。
/// 浏览器发起的跨域请求**必定**带 Origin 且不允许 JS 伪造，所以这里按来源卡死：
/// - `None`：扩展 service worker 不一定发 Origin，curl 等本地工具也不发，允许；
///   网页想走这条路就得发「简单请求」，而简单请求带不上 `x-fluxdl-token` 自定义头。
/// - `chrome-extension://` / `moz-extension://`：扩展上下文，允许。
/// - 其它（`http(s)://`、`null`、file 等）：网页，一律拒绝。
pub fn is_allowed_origin(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(value) => {
            value.starts_with("chrome-extension://") || value.starts_with("moz-extension://")
        }
    }
}

/// Host 白名单：只认回环地址 + 约定端口，防 DNS rebinding。
///
/// 攻击者把域名解析到 127.0.0.1 后，请求会以「同源」形式打进来，
/// 此时 Origin 可能是网页域名、也可能缺失，但 Host 一定不是回环地址。
pub fn is_allowed_host(host: Option<&str>) -> bool {
    let Some(host) = host.map(str::trim) else {
        // HTTP/1.1 必须带 Host，缺失即视为异常请求
        return false;
    };
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    let loopback = name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost");
    if !loopback {
        return false;
    }
    match port {
        None => true,
        Some(port) => port.parse::<u16>().ok() == Some(CAPTURE_PORT),
    }
}

/// 综合准入检查。任何请求（含 OPTIONS 预检、/api/health）都必须先过这一关。
pub fn check(headers: &HashMap<String, String>) -> Result<(), &'static str> {
    if !is_allowed_host(headers.get("host").map(String::as_str)) {
        return Err("请求目标不是本机回环地址");
    }
    if !is_allowed_origin(headers.get("origin").map(String::as_str)) {
        return Err("请求来源不允许");
    }
    Ok(())
}

/// 需要回显给扩展的 CORS Origin。
///
/// 只回显扩展自身的 Origin，不再返回 `*`。网页拿不到允许头，预检就会失败。
pub fn extension_origin(headers: &HashMap<String, String>) -> Option<&str> {
    let origin = headers.get("origin")?.as_str();
    if origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://") {
        Some(origin)
    } else {
        None
    }
}

/// 构造完整 HTTP 响应。抽成纯函数，便于验证 CORS 头不会退化成 `*`。
pub fn build_response(
    status: u16,
    reason: &str,
    body: &str,
    allow_origin: Option<&str>,
) -> String {
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Access-Control-Allow-Headers: content-type, x-fluxdl-token\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n",
        len = body.len(),
    );
    if let Some(origin) = allow_origin {
        head.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\n"));
        head.push_str("Vary: Origin\r\n");
    }
    head.push_str("\r\n");
    head.push_str(body);
    head
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn browser() -> HashMap<String, String> {
        headers(&[
            ("host", "127.0.0.1:35917"),
            ("origin", "https://evil.example.com"),
        ])
    }

    #[test]
    fn 网页来源一律拒绝() {
        assert!(!is_allowed_origin(Some("https://evil.example.com")));
        assert!(!is_allowed_origin(Some("http://localhost:8080")));
        assert!(!is_allowed_origin(Some("null")));
        assert!(!is_allowed_origin(Some("file://")));
        assert!(check(&browser()).is_err());
    }

    #[test]
    fn 扩展来源与无来源允许() {
        assert!(is_allowed_origin(Some("chrome-extension://abcdefghijklmnop")));
        assert!(is_allowed_origin(Some("moz-extension://{uuid}")));
        assert!(is_allowed_origin(None));
        assert!(check(&headers(&[
            ("host", "127.0.0.1:35917"),
            ("origin", "chrome-extension://abcdefghijklmnop"),
        ]))
        .is_ok());
        assert!(check(&headers(&[("host", "127.0.0.1:35917")])).is_ok());
    }

    #[test]
    fn 只放行回环地址与约定端口() {
        assert!(is_allowed_host(Some("127.0.0.1:35917")));
        assert!(is_allowed_host(Some("localhost:35917")));
        assert!(is_allowed_host(Some("LOCALHOST:35917")));
        assert!(is_allowed_host(Some("127.0.0.1")));
        assert!(!is_allowed_host(Some("evil.example.com")));
        assert!(!is_allowed_host(Some("evil.example.com:35917")));
        assert!(!is_allowed_host(Some("127.0.0.1:8080")));
        assert!(!is_allowed_host(Some("192.168.1.5:35917")));
        assert!(!is_allowed_host(Some("[::1]:35917")));
        assert!(!is_allowed_host(None));
    }

    #[test]
    fn dns_rebinding_被_host_校验挡住() {
        let h = headers(&[
            ("host", "evil.example.com"),
            ("origin", "chrome-extension://abcdefghijklmnop"),
        ]);
        assert_eq!(check(&h), Err("请求目标不是本机回环地址"));
    }

    #[test]
    fn 网页请求即使带令牌也不能通过准入() {
        let h = headers(&[
            ("host", "127.0.0.1:35917"),
            ("origin", "https://evil.example.com"),
            ("x-fluxdl-token", "fluxdl-local-v1"),
            ("content-type", "text/plain"),
        ]);
        assert_eq!(check(&h), Err("请求来源不允许"));
        assert_eq!(extension_origin(&h), None);
    }

    #[test]
    fn 响应不再返回通配符_acao() {
        let denied = build_response(403, "Forbidden", "{}", None);
        assert!(!denied.contains("Access-Control-Allow-Origin"));
        assert!(denied.starts_with("HTTP/1.1 403 Forbidden"));

        let ext = "chrome-extension://abcdefghijklmnop";
        let allowed = build_response(200, "OK", "{}", Some(ext));
        assert!(allowed.contains(&format!("Access-Control-Allow-Origin: {ext}")));
        assert!(allowed.contains("Vary: Origin"));
        assert!(!allowed.contains("Access-Control-Allow-Origin: *"));

        let no_origin = build_response(200, "OK", "{}", None);
        assert!(!no_origin.contains("Access-Control-Allow-Origin"));
    }

    #[test]
    fn 响应头使用真实字节长度() {
        // 中文等多字节字符必须按字节数，否则浏览器会截断响应体
        let body = r#"{"ok":false,"error":"请求来源不允许"}"#;
        let resp = build_response(403, "Forbidden", body, None);
        assert!(resp.contains(&format!("Content-Length: {}", body.len())));
    }
}
