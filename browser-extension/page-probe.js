/**
 * FluxDL 页面媒体探针 — MAIN world（document_start 注入）
 *
 * 借鉴 StreamFirefly 的「页面内探针」思路，但只做一件事：把「藏在 JSON 接口 /
 * 内联脚本 / HLS-DASH 清单里的 http(s) 媒体直链」找出来，交给扩展的既有链路。
 *
 * 为什么需要它：现有扩展只靠 chrome.webRequest 看「响应头」。抖音 / 快手这类
 * SPA 把真实 mp4 地址放在 XHR/fetch 返回的 JSON body 里（如 play_addr.url_list），
 * 或通过 Blob / MediaSource 播放，webRequest 只能看到那个 JSON 请求，看不到
 * body 里的直链。MAIN world 探针能读到页面自己拿到的响应文本，补上这个缺口。
 *
 * 设计边界（务必保持）：
 * 1) 只读「URL 字符串」，不读取、不携带、不存储任何 cookie / Authorization /
 *    token / 请求体里的凭证。不 override 请求头，不带 credentials 重发请求。
 * 2) 只上报 http(s) 绝对地址；blob: / data: / 相对地址一律不发。
 * 3) 所有扫描有预算上限（文本体积、节点数、深度、去重集合、单次 emit 条数），
 *    避免在大页面上拖慢页面或爆内存。
 * 4) 幂等安装：window.__fluxdlProbeInstalled 防重复 hook。
 * 5) 通过 window.postMessage 与 ISOLATED world 的 probe-bridge.js 单向通信；
 *    MAIN world 拿不到 chrome.*，不能直接 sendMessage。
 *
 * 本文件既要在浏览器 MAIN world 跑，也要能在 Node 里用 new Function 加载做
 * 契约测试，所以末尾用 `typeof module !== "undefined"` 守卫导出纯函数。
 */
(function () {
  "use strict";

  const TAG = "__fluxdlProbe__";           // postMessage 专用标记，防止误收别的消息
  const BODY_LIMIT = 2 * 1024 * 1024;       // 单个响应 / 脚本文本最大扫描字节
  const INLINE_LIMIT = 2 * 1024 * 1024;     // 内联 manifest 最大体积
  const MAX_URL_LEN = 16384;                // 单条 URL 上限
  const MAX_SCAN_DEPTH = 12;                // JSON 递归深度
  const MAX_SCAN_NODES = 8000;              // JSON 遍历节点上限
  const MAX_EMIT = 40;                      // 单次 emit 最多上报条数
  const SEEN_LIMIT = 2000;                  // 去重集合上限，超了就滚动清理

  // 媒体容器 / 清单扩展名。注意与桌面端 is_direct_media_file 的容器集合大体对齐。
  // .m3u8/.mpd 是清单，交给 background 的 classify → markStream 标记「本页有视频」。
  const MEDIA_EXT = /\.(mp4|m4v|mkv|webm|mov|flv|avi|mp3|m4a|aac|flac|wav|ogg|opus|m3u8|mpd)(?:[?#]|$)/i;
  // 分片（HLS/DASH 的 segment 与密钥）：FluxDL 目前没有分片合并器，单独下载这些
  // 得不到完整视频，列进「本页资源」只会误导用户。webRequest 侧本来就会把
  // m4s/m3u8/mpd 判为 stream 标记，探针不必重复上报分片，直接排除。
  const SEGMENT_EXT = /\.(m4s|ts|m2ts|key)(?:[?#]|$)/i;
  // 明确不是媒体资源的静态资源，避免把 PWA manifest / sourcemap / 接口 json 当视频。
  const NOISE_EXT = /\.(webmanifest|manifest|json|map|js|mjs|css|html?|txt|xml|ico|svg|png|jpe?g|gif|webp|bmp|woff2?|ttf|eot)(\?|#|$)/i;
  // 从任意文本里抓 http(s) 绝对 URL（含查询串签名参数）。
  const URL_RE = /https?:\/\/[^\s"'<>`\\\[\]{}]+/gi;
  // 命名空间式误判：形如 a.b.c.mp4、foo.bar.m3u8 的 JS 属性链，不是 URL。
  const NS_REF = /^[a-z_$][\w$.]*\.(mp4|m3u8|mpd|ts|m4s)$/i;
  // 抖音 / 快手 CDN 直链常无扩展名（path 以 / 结尾），但查询串带明确的视频
  // MIME 线索：mime_type=video_mp4 / mimeType=video / media_type=video 等。
  // 这是强信号 —— 页面链接 / JSON 接口地址不会带它，误收风险极低。
  // 必须与 background.js 的 inferProbeMime 保持同一规则（见契约测试）。
  const VIDEO_MIME_HINT = /[?&](?:mime_?type|mime|media_?type|content_?type)=video/i;

  /** 归一化并严格校验一条候选 URL；不合格返回 ""。 */
  function normalizeUrl(raw) {
    let url = String(raw || "").trim();
    // JSON 常见转义：https:\/\/cdn\/x.mp4 → https://cdn/x.mp4
    url = url.replace(/\\\//g, "/");
    // 去掉尾部被一起吞进来的引号 / 标点（URL_RE 已排除大部分，这里兜底括号）。
    url = url.replace(/[,;。、，'"\\)\]}】]+$/, "");
    if (!url || url.length > MAX_URL_LEN) return "";
    if (!/^https?:\/\//i.test(url)) return "";        // 只收 http(s) 绝对地址
    if (/[\x00-\x20\x7f]/.test(url)) return "";        // 控制字符 / 空格
    // 凭据一律不接受：URL 里带 user:pass@ 的直接丢弃
    try {
      const u = new URL(url);
      if (!/^https?:$/i.test(u.protocol) || u.username || u.password) return "";
    } catch {
      return "";
    }
    return url;
  }

  /** 判断一条 URL 是否值得作为媒体候选上报。 */
  function looksLikeMedia(url) {
    const full = String(url);
    // 只看 path：查询串里可能带 .json / token=xxx.map，不能让它误杀整条视频直链。
    const path = full.split(/[?#]/)[0];
    if (NOISE_EXT.test(path)) return false;            // PWA manifest / 配置 json 等
    if (SEGMENT_EXT.test(path)) return false;          // 分片 / 密钥不下发
    if (NS_REF.test(path)) return false;               // a.b.c.mp4 之类属性链
    if (MEDIA_EXT.test(path)) return true;             // 命中媒体 / 清单扩展名
    return VIDEO_MIME_HINT.test(full);                 // 无扩展名但有明确视频 MIME 线索
  }

  /** 从一段文本里提取所有合格的 http(s) 媒体直链（去重、限量、带预算）。 */
  function extractUrls(text) {
    const out = [];
    if (typeof text !== "string" || !text) return out;
    const sample = text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) : text;
    URL_RE.lastIndex = 0;
    let match;
    while ((match = URL_RE.exec(sample)) !== null) {
      const url = normalizeUrl(match[0]);
      if (url && looksLikeMedia(url)) out.push(url);
      if (out.length >= MAX_EMIT) break;
    }
    return dedupe(out);
  }

  /**
   * 递归扫描已解析的 JSON 值，把字符串里出现的媒体 URL 收集起来。
   * 深度 / 节点数双上限，防止恶意超深对象拖死页面。
   */
  function scanValue(value, state, depth) {
    if (depth > MAX_SCAN_DEPTH || state.nodes >= MAX_SCAN_NODES) return;
    if (value == null) return;
    const t = typeof value;
    if (t === "string") {
      state.nodes += 1;
      // 字符串本身就是一条 URL
      const direct = normalizeUrl(value);
      if (direct && looksLikeMedia(direct) && state.out.length < MAX_EMIT) {
        state.out.push(direct);
      } else if (value.length <= 64 * 1024) {
        // 字符串里内嵌 URL（如被拼接的描述文本）
        for (const u of extractUrls(value)) {
          if (state.out.length >= MAX_EMIT) break;
          state.out.push(u);
        }
      }
      return;
    }
    if (t !== "object") return;
    state.nodes += 1;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (state.nodes >= MAX_SCAN_NODES || state.out.length >= MAX_EMIT) break;
        scanValue(item, state, depth + 1);
      }
    } else {
      for (const key of Object.keys(value)) {
        if (state.nodes >= MAX_SCAN_NODES || state.out.length >= MAX_EMIT) break;
        scanValue(value[key], state, depth + 1);
      }
    }
  }

  /** 从一个「可能是 JSON」的文本里提取媒体 URL；非 JSON 也没关系，走纯文本提取。 */
  function extractFromBody(text) {
    const state = { out: [], nodes: 0 };
    if (typeof text !== "string" || !text) return state.out;
    const sample = text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) : text;
    const trimmed = sample.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        scanValue(JSON.parse(sample), state, 0);
      } catch {
        // 不是合法 JSON：退化为纯文本正则提取
        for (const u of extractUrls(sample)) state.out.push(u);
      }
    } else {
      for (const u of extractUrls(sample)) state.out.push(u);
    }
    return dedupe(state.out).slice(0, MAX_EMIT);
  }

  /**
   * 处理内联 HLS / DASH 清单：主清单里常常是「相对 URL」的子清单 / 分片，
   * URL_RE 抓不到（没有协议头），需要按 baseUrl 解析成绝对地址。
   * 只收子清单（.m3u8/.mpd）与整文件容器；.ts / .m4s / .key 分片与密钥一律
   * 不上报 —— FluxDL 目前没有分片合并器，列出来下不了还会刷屏。分片的存在会
   * 由 webRequest 侧的 classify 自动标记为「本页有视频」，无需探针重复上报。
   */
  function extractFromManifest(text, baseUrl) {
    const out = [];
    if (typeof text !== "string" || !text) return out;
    const sample = text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) : text;
    if (!/#EXTM3U/i.test(sample) && !/<MPD[\s>]/i.test(sample)) return out;
    for (const rawLine of sample.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      let abs = "";
      try {
        abs = normalizeUrl(new URL(line, baseUrl).href);
      } catch {
        abs = normalizeUrl(line);
      }
      // 清单里的 .ts / .m4s 分片与 .key 密钥不单独上报：FluxDL 目前没有自研
      // 分片下载器，列出来既下不了又会刷屏；只收子清单（m3u8/mpd）与整文件容器。
      if (abs && /\.(m3u8|mpd|mp4|m4v|mkv|webm|mov|flv|avi|mp3|m4a|aac|wav)(\?|#|$)/i.test(abs)
          && !NOISE_EXT.test(abs.split(/[?#]/)[0])) {
        out.push(abs);
      }
      if (out.length >= MAX_EMIT) break;
    }
    return dedupe(out);
  }

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const u of list) {
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
    return out;
  }

  /**
   * 从 performance.getEntriesByType("resource") 补漏：探针运行在 document_start，
   * 但仍可能漏掉「由 HTML 标签 / CSS / 浏览器内部发起」的请求（<video src>、
   * <link rel=preload> 等不走 fetch/XHR hook），以及 hook 安装前已完成的条目。
   * 只读 entry.name（URL 字符串），不读取任何响应体 / 凭据。
   */
  function extractFromPerformance(entries) {
    const out = [];
    if (!Array.isArray(entries)) return out;
    const limit = Math.min(entries.length, 600);
    for (let i = 0; i < limit && out.length < MAX_EMIT; i += 1) {
      const item = entries[i];
      const raw = typeof item === "string" ? item : (item && item.name);
      const url = normalizeUrl(raw);
      if (url && looksLikeMedia(url)) out.push(url);
    }
    return dedupe(out);
  }

  /**
   * 从 <video> / <audio> / <source> 的 src / currentSrc 补漏。preload="none"
   * 的播放器把直链写在 DOM 上却从不发请求，webRequest 与 fetch hook 都看不到。
   * blob:/data: 地址由 normalizeUrl 直接拒绝；相对地址按 baseUrl 解析成绝对地址。
   * 仍走 looksLikeMedia 过滤，保证与 background 的 probeResourceKind 收录面一致。
   */
  function extractFromMediaElements(doc, baseUrl) {
    const out = [];
    if (!doc || typeof doc.querySelectorAll !== "function") return out;
    let nodes;
    try {
      nodes = doc.querySelectorAll("video, audio, source");
    } catch {
      return out;
    }
    if (!nodes || typeof nodes.length !== "number") return out;
    for (let i = 0; i < nodes.length && out.length < MAX_EMIT; i += 1) {
      const el = nodes[i] || {};
      for (const attr of ["currentSrc", "src"]) {
        let raw = "";
        try {
          raw = String(el[attr] || (typeof el.getAttribute === "function" ? el.getAttribute(attr) : "") || "");
        } catch { /* noop */ }
        if (!raw) continue;
        let abs = "";
        try {
          abs = normalizeUrl(new URL(raw, baseUrl || undefined).href);
        } catch {
          abs = normalizeUrl(raw);
        }
        if (abs && looksLikeMedia(abs)) {
          out.push(abs);
          break;
        }
      }
    }
    return dedupe(out);
  }

  // ---- 浏览器侧安装（Node 测试里这些全局是 stub，install 会被显式调用）----

  /** 全局去重集合：同一 URL 只上报一次，避免 MutationObserver 反复触发刷屏。 */
  function makeEmitter(postMessage, getPageUrl) {
    const seen = new Set();
    const pageUrl = typeof getPageUrl === "function" ? getPageUrl : () => "";
    return function emit(urls, source) {
      const fresh = [];
      for (const u of urls || []) {
        if (seen.has(u)) continue;
        seen.add(u);
        fresh.push(u);
      }
      if (seen.size > SEEN_LIMIT) {
        // 滚动清理：丢弃一半，防止长期驻留 SPA 的 Set 无限增长
        let i = 0;
        for (const u of seen) {
          seen.delete(u);
          if (++i >= SEEN_LIMIT / 2) break;
        }
      }
      if (!fresh.length) return fresh;
      // targetOrigin 用 "*"：MAIN world 与 ISOLATED world 共享同一 window，
      // postMessage 是两者间标准桥梁；接收侧（probe-bridge.js）做来源校验。
      // pageUrl 只作下载 referer，不含任何 cookie / 凭证。
      postMessage({
        [TAG]: true,
        urls: fresh,
        source: source || "probe",
        pageUrl: String(pageUrl() || "").slice(0, MAX_URL_LEN),
      }, "*");
      return fresh;
    };
  }

  /**
   * 安装 hook。全部包在 try 里：页面若冻结了某个原生对象，单个 hook 失败不影响其它。
   * 返回 uninstall 便于测试清理。
   */
  function install(win, doc) {
    if (!win || win.__fluxdlProbeInstalled) return () => {};
    // world 判别：ISOLATED world 里能拿到 chrome.runtime.id；MAIN world 拿不到。
    // Chrome < 111 会把声明为 MAIN 的脚本降级注入到 ISOLATED，此时直接跳过，
    // 保持「webRequest 嗅探」原样工作，零副作用。
    if (win.chrome && win.chrome.runtime && win.chrome.runtime.id) return () => {};
    win.__fluxdlProbeInstalled = true;

    const post =
      typeof win.postMessage === "function"
        ? win.postMessage.bind(win)
        : () => {};
    const emit = makeEmitter(post, () => baseHref(win));
    const originals = [];

    // 1) fetch：clone 响应后读文本，绝不消费页面自己要用的 response。
    try {
      const origFetch = win.fetch;
      if (typeof origFetch === "function") {
        win.fetch = function (...args) {
          const input = args[0];
          const requestUrl =
            typeof input === "string" || (input && typeof input.url === "string")
              ? String(input.url || input)
              : "";
          return origFetch.apply(this, args).then((response) => {
            try {
              const ct = response && response.headers && response.headers.get
                ? String(response.headers.get("content-type") || "").toLowerCase()
                : "";
              if (requestUrl && looksLikeMedia(normalizeUrl(requestUrl))) {
                emit(extractUrls(requestUrl), "fetch-url");
              }
              // 只读文本类响应；视频二进制 / 图片 / 字体一律不读
              if (response && typeof response.clone === "function" &&
                  !/^(video|audio|image|font)\//.test(ct) &&
                  ct.indexOf("octet-stream") === -1) {
                response.clone().text().then((text) => {
                  const found = extractFromBody(text);
                  const manifest = extractFromManifest(text, requestUrl || baseHref(win));
                  const urls = dedupe([...found, ...manifest]).slice(0, MAX_EMIT);
                  if (urls.length) emit(urls, "fetch-body");
                }).catch(() => {});
              } else if (/mpegurl|dash\+xml|m3u8|mpd/i.test(ct + requestUrl)) {
                response.clone().text().then((text) => {
                  const urls = extractFromManifest(text, requestUrl || baseHref(win));
                  if (urls.length) emit(urls, "fetch-manifest");
                }).catch(() => {});
              }
            } catch {
              // 单个响应处理失败不影响页面
            }
            return response;
          });
        };
        originals.push(() => { win.fetch = origFetch; });
      }
    } catch { /* fetch 不可 hook 时跳过 */ }

    // 2) XMLHttpRequest：open 记 url，load 时按 responseType 读文本。
    try {
      const OrigXHR = win.XMLHttpRequest;
      if (typeof OrigXHR === "function") {
        const origOpen = OrigXHR.prototype.open;
        const origSend = OrigXHR.prototype.send;
        OrigXHR.prototype.open = function (method, url, ...rest) {
          try { this.__fluxdlUrl = String(url || ""); } catch { /* noop */ }
          return origOpen.call(this, method, url, ...rest);
        };
        OrigXHR.prototype.send = function (...args) {
          try {
            this.addEventListener("load", () => {
              try {
                const reqUrl = this.__fluxdlUrl || "";
                if (reqUrl && looksLikeMedia(normalizeUrl(reqUrl))) {
                  emit(extractUrls(reqUrl), "xhr-url");
                }
                let text = "";
                const rt = this.responseType;
                if (rt === "" || rt === "text") text = String(this.responseText || "");
                else if (rt === "json" && this.response != null) {
                  try { text = JSON.stringify(this.response); } catch { /* noop */ }
                }
                if (text) {
                  const found = extractFromBody(text);
                  const manifest = extractFromManifest(text, reqUrl || baseHref(win));
                  const urls = dedupe([...found, ...manifest]).slice(0, MAX_EMIT);
                  if (urls.length) emit(urls, "xhr-body");
                }
              } catch { /* noop */ }
            });
          } catch { /* noop */ }
          return origSend.apply(this, args);
        };
        originals.push(() => {
          OrigXHR.prototype.open = origOpen;
          OrigXHR.prototype.send = origSend;
        });
      }
    } catch { /* XHR 不可 hook 时跳过 */ }

    // 3) URL.createObjectURL：Blob 里的内联清单 / 文本可能藏着媒体 URL。
    //    只读小体积文本，绝不读取大视频 Blob（避免内存爆炸）；blob: URL 不上报。
    try {
      const URLCtor = win.URL;
      if (URLCtor && typeof URLCtor.createObjectURL === "function") {
        const origCreate = URLCtor.createObjectURL;
        URLCtor.createObjectURL = function (obj) {
          try {
            if (obj && typeof obj.text === "function" && typeof obj.size === "number" &&
                obj.size > 0 && obj.size <= INLINE_LIMIT) {
              obj.text().then((text) => {
                const urls = extractFromBody(text);
                const manifest = extractFromManifest(text, baseHref(win));
                const all = dedupe([...foundMerge(urls, manifest)]).slice(0, MAX_EMIT);
                if (all.length) emit(all, "blob");
              }).catch(() => {});
            }
          } catch { /* noop */ }
          return origCreate.call(this, obj);
        };
        originals.push(() => { URLCtor.createObjectURL = origCreate; });
      }
    } catch { /* 不可 hook 时跳过 */ }

    // 4) MutationObserver：SPA 路由切换后新插入的内联 <script> 重新扫描；
    //    同时补扫 DOM 媒体元素与 performance 资源条目（标签发起的请求不走
    //    fetch/XHR hook，preload="none" 的 <video src> 甚至从不发请求）。
    try {
      const MO = win.MutationObserver;
      if (typeof MO === "function" && doc && doc.documentElement) {
        let timer = null;
        const deferred = [];      // 有限次数的定时补扫，uninstall 时统一清理
        const scanPage = () => {
          try {
            const perf = win.performance;
            const entries = perf && typeof perf.getEntriesByType === "function"
              ? perf.getEntriesByType("resource")
              : [];
            emit(extractFromPerformance(entries), "performance");
          } catch { /* noop */ }
          try {
            emit(extractFromMediaElements(doc, baseHref(win)), "media-element");
          } catch { /* noop */ }
        };
        const scanScripts = () => {
          try {
            const scripts = doc.querySelectorAll("script:not([src])");
            for (let i = 0; i < scripts.length; i += 1) {
              const text = String(scripts[i].textContent || "").slice(0, BODY_LIMIT);
              if (text) {
                const urls = extractFromBody(text);
                if (urls.length) emit(urls, "inline-script");
              }
            }
          } catch { /* noop */ }
        };
        const observer = new MO(() => {
          if (timer) win.clearTimeout(timer);
          timer = win.setTimeout(() => { scanScripts(); scanPage(); }, 400);  // 防抖，避免高频 DOM 变动
        });
        observer.observe(doc.documentElement, {
          childList: true, characterData: true, subtree: true,
        });
        // 首屏也扫一次；播放器常在 DOM 稳定后才写 src，再补两次（有限次数，不常驻）。
        deferred.push(win.setTimeout(() => { scanScripts(); scanPage(); }, 0));
        deferred.push(win.setTimeout(scanPage, 800));
        deferred.push(win.setTimeout(scanPage, 2500));
        originals.push(() => {
          observer.disconnect();
          if (timer) win.clearTimeout(timer);
          for (const t of deferred) win.clearTimeout(t);
        });
      }
    } catch { /* 不支持时跳过 */ }

    return function uninstall() {
      for (const restore of originals) {
        try { restore(); } catch { /* noop */ }
      }
      delete win.__fluxdlProbeInstalled;
    };
  }

  function foundMerge(a, b) {
    return [...a, ...b];
  }

  function baseHref(win) {
    try { return String(win.location && win.location.href || ""); }
    catch { return ""; }
  }

  // 浏览器 MAIN world：自动安装。判定条件刻意收窄到「真实页面全局对象」：
  // window === globalThis 且有 location —— Node 契约测试用 new Function 注入的
  // window 只是普通对象、不等于 globalThis，因此不会误触发 install，测试改用
  // 显式调用 api.install(stubWindow, stubDoc)，行为完全可控。
  const isRealPage =
    typeof window !== "undefined" && window === globalThis &&
    typeof document !== "undefined" && Boolean(window.location);
  const root = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null);
  if (isRealPage) {
    install(window, document);
  }

  // 供 Node 契约测试加载纯函数；MAIN world 里 module 未定义，不会执行。
  const api = {
    TAG, BODY_LIMIT, MAX_EMIT, MAX_URL_LEN,
    normalizeUrl, looksLikeMedia, extractUrls, extractFromBody,
    extractFromManifest, extractFromPerformance, extractFromMediaElements,
    scanValue, dedupe, makeEmitter, install,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  // 浏览器里挂到全局便于调试台查看（仅纯函数，不含任何凭证数据）。
  if (isRealPage && root) root.__fluxdlProbeApi = api;
})();
