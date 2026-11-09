/**
 * FluxDL 探针桥接 — ISOLATED world content script（document_start 注入）
 *
 * MAIN world 的 page-probe.js 拿不到 chrome.*，只能通过 window.postMessage 把
 * 嗅探到的 URL 发出来；本脚本运行在 ISOLATED world，能访问 chrome.runtime，
 * 负责校验并转发给 background service worker。
 *
 * 安全契约（跨 world 通道必须收紧）：
 * 1) 只接受 event.source === window 的同窗口消息，且带专用 TAG 标记；
 * 2) 只转发 urls 数组里的 http(s) 字符串，字段白名单，绝不透传其它内容；
 *    页面里的第三方脚本也能伪造 postMessage，所以这里再做一次 URL 校验，
 *    background 里还有第三道校验（classify）。
 * 3) 单次转发有数量上限，防止恶意页面刷爆 service worker。
 */
(function () {
  "use strict";

  const TAG = "__fluxdlProbe__";
  const MAX_FORWARD = 40;
  const MAX_URL_LEN = 16384;
  const MAX_ITEMS = 200;
  const MAX_MEDIA_FORWARD = 24;

  /** 校验一条消息，返回要转发的 URL 数组；不合格返回 []。 */
  function sanitizeMessage(data, sourceIsWindow) {
    if (!sourceIsWindow || !data || typeof data !== "object") return [];
    if (data[TAG] !== true) return [];
    const urls = Array.isArray(data.urls) ? data.urls : [];
    const out = [];
    for (let i = 0; i < urls.length && i < MAX_ITEMS; i += 1) {
      const u = String(urls[i] || "");
      if (u.length > MAX_URL_LEN || !/^https?:\/\//i.test(u)) continue;
      if (/[\x00-\x20\x7f]/.test(u)) continue;          // 控制字符 / 空格
      // 绝不转发带 user:pass@ 的地址（凭证红线）
      try {
        const parsed = new URL(u);
        if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) continue;
      } catch {
        continue;
      }
      if (!out.includes(u)) out.push(u);
      if (out.length >= MAX_FORWARD) break;
    }
    return out;
  }

  /**
   * 结构化解析条目（media）单独走白名单：字段位置已确认是视频正片，URL 常无
   * 扩展名，因此这里只做与 sanitizeMessage 同级的 URL 硬校验，绝不透传任何
   * 未知字段、请求头或凭证。返回干净的条目数组。
   */
  function clip(value, limit) {
    return typeof value === "string" ? value.slice(0, limit) : "";
  }

  function sanitizeMedia(data, sourceIsWindow) {
    if (!sourceIsWindow || !data || typeof data !== "object") return [];
    if (data[TAG] !== true) return [];
    const list = Array.isArray(data.media) ? data.media : [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < list.length && i < MAX_ITEMS; i += 1) {
      const m = list[i];
      if (!m || typeof m !== "object") continue;
      const u = String(m.url || "");
      if (u.length > MAX_URL_LEN || !/^https?:\/\//i.test(u)) continue;
      if (/[\x00-\x20\x7f]/.test(u)) continue;
      try {
        const parsed = new URL(u);
        if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) continue;
      } catch {
        continue;
      }
      if (seen.has(u)) continue;                 // 同 URL 只保留首条（保留其标题 / 清晰度等元信息）
      seen.add(u);
      const platform = /^(douyin|kuaishou)$/i.test(String(m.platform || "")) ? "detail" : "";
      out.push({
        url: u,
        title: clip(m.title, 120),
        author: clip(m.author, 60),
        ratio: clip(m.ratio, 32),
        platform,
      });
      if (out.length >= MAX_MEDIA_FORWARD) break;
    }
    return out;
  }

  /** 生成发给 background 的负载。pageUrl 只用于 referer，不含任何凭证。 */
  function buildPayload(data, urls, media) {
    const payload = {
      type: "probeResources",
      urls,
      pageUrl: typeof data.pageUrl === "string" ? data.pageUrl.slice(0, MAX_URL_LEN) : "",
      source: typeof data.source === "string" ? String(data.source).slice(0, 40) : "probe",
    };
    // 只在有结构化条目时附加该字段，旧消息形态保持完全一致。
    if (Array.isArray(media) && media.length) payload.media = media;
    return payload;
  }

  function install(win, runtime) {
    if (!win || typeof win.addEventListener !== "function") return () => {};
    const handler = (event) => {
      // 跨 world（MAIN → ISOLATED）的 postMessage，event.source 在部分 Chrome
      // 版本里可能是 null；同源同窗口的消息 source 为 window。二者都接受，
      // 拒绝的只是「别的窗口 / iframe 顶层」发来的消息。真正的安全边界是
      // TAG 标记 + http(s) 校验 + background 的第三道校验，伪造消息最多只能
      // 往资源列表塞几条 URL，不构成提权。
      const source = event && event.source;
      const fromSelf = !source || source === win;
      const urls = sanitizeMessage(event && event.data, fromSelf);
      const media = sanitizeMedia(event && event.data, fromSelf);
      if (!urls.length && !media.length) return;
      try {
        runtime.sendMessage(buildPayload(event.data, urls, media), () => {
          // 吞掉 lastError：扩展热重载 / service worker 休眠时 sendMessage 会回调报错
          try { void (runtime.lastError || (win.chrome && win.chrome.runtime && win.chrome.runtime.lastError)); }
          catch { /* noop */ }
        });
      } catch {
        // 扩展上下文失效时静默丢弃，不影响页面
      }
    };
    win.addEventListener("message", handler);
    return () => {
      try { win.removeEventListener("message", handler); } catch { /* noop */ }
    };
  }

  // 真实浏览器 content script：自动安装。
  // ISOLATED world 一定有 chrome.runtime；Node 测试用显式 install。
  if (typeof window !== "undefined" && typeof document !== "undefined" &&
      typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
    install(window, chrome.runtime);
  }

  const api = {
    TAG, MAX_FORWARD, MAX_URL_LEN, MAX_MEDIA_FORWARD,
    sanitizeMessage, sanitizeMedia, buildPayload, install,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
