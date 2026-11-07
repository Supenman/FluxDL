/**
 * FluxDL 链接捕获扩展 — MV3 service worker
 *
 * 设计要点：
 * 1) 自动接管：浏览器一旦开始下载 http(s) 资源就无条件交给桌面端。
 *    不再有「扩展名白名单 / 最小体积 / 分组开关」这类接管范围限制。
 * 2) 资源嗅探：监听所有响应头，把页面上真正可下载的媒体与文件收集起来，
 *    按标签页缓存，弹窗里像 IDM 一样列出来供点选。
 * 3) 流媒体站点：m4s / m3u8 / mpd 分片本身不能直接下，标记为「本页有视频」，
 *    交给桌面端内置 yt-dlp 解析整个页面（B 站、YouTube 等）。
 */
const API = "http://127.0.0.1:35917";
const TOKEN = "fluxdl-local-v1";
const MENU_LINK = "fluxdl-download-link";
const MENU_MEDIA = "fluxdl-download-media";

const DEFAULT_SETTINGS = { autoCapture: true };
const MAX_RESOURCES = 48;

// 注意：下面两个正则只用于「弹窗里显示哪些资源」，不是接管范围。
const FILE_EXT = /\.(mp4|m4v|mkv|webm|avi|mov|flv|wmv|mpg|mpeg|m2ts|mp3|m4a|aac|flac|wav|ogg|opus|wma|ape|zip|rar|7z|tar|gz|bz2|xz|zst|tgz|txz|iso|dmg|img|exe|msi|msix|appx|apk|deb|rpm|pkg|pdf|doc|docx|xls|xlsx|ppt|pptx|epub|mobi|azw3|rtf|odt|bin|dat)(?:[?#]|$)/i;
const STREAM_EXT = /\.(m4s|m3u8|mpd)(?:[?#]|$)/i;
// 探针链路专用：与 page-probe.js 的 SEGMENT_EXT 逐字一致。分片 / 密钥不是完整
// 视频，探针不下发，background 也不得把这类 URL 收进「本页资源」。
// 不能改 classify()：webRequest 看到的真实 .m4s 请求仍需标记「本页有视频」(stream)，
// 那是另一条链路；这里只约束 probeResources 消息。
const PROBE_SEGMENT_EXT = /\.(m4s|ts|m2ts|key)(?:[?#]|$)/i;
// 只列国内站点：与桌面端 `looks_like_media` 保持一致。
// 国外站点不做特殊适配，页面上嗅到的直链仍会作为普通下载发送。
const VIDEO_HOSTS = [
  "bilibili.com", "b23.tv", "douyin.com", "iesdouyin.com",
  "kuaishou.com", "xiaohongshu.com", "xhslink.com", "weibo.com",
  "iqiyi.com", "youku.com", "mgtv.com", "v.qq.com",
  "music.163.com", "zhihu.com", "ixigua.com", "acfun.cn",
];

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return "";
  const hit = headers.find(
    (h) => h && h.name && h.name.toLowerCase() === name,
  );
  return hit ? String(hit.value || "") : "";
}

// 完整容器直链：CDN 上的视频 / 音频整文件，按普通下载处理，不交给 yt-dlp。
// 规则须与 Rust is_direct_media_file、前端 isDirectMediaFile 保持一致；
// 分片清单 .m3u8 / .mpd / .m4s 不在其中，仍需 yt-dlp 合并。
const DIRECT_MEDIA_EXT = /\.(mp4|m4v|mkv|webm|mov|flv|avi|ts|mp3|m4a|aac|flac|wav|ogg|opus)(?:[?#]|$)/i;

function isDirectMediaFile(url) {
  return DIRECT_MEDIA_EXT.test(String(url).split(/[?#]/)[0]);
}

/**
 * 该网页链接是否无法交给 yt-dlp 整页解析。
 * 0.3.4 真机截图：快手 /new-reco、抖音 /jingxuan 这类首页、发现页、精选页
 * 被当成「本页视频」发送，yt-dlp 一律报 Unsupported URL。
 * 内置解析器（2026.10.26）没有任何快手 / Kwai 提取器，这条路是关闭的。
 */
function isUnsupportedPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  const isKs =
    host === "kuaishou.com" || host.endsWith(".kuaishou.com") ||
    host === "kwai.com" || host.endsWith(".kwai.com");
  if (isKs) return true;

  // 0.3.6：抖音**所有**网页链接都不再尝试整页解析。打包版 yt-dlp 虽带
  // Douyin 提取器，但 /video/<id> 仍要求浏览器下发的匿名校验 cookie（真机
  // 截图：Fresh cookies），FluxDL 不读取凭证；0.3.5 的 modal_id 归一化在真机
  // 上同样失败。引擎侧 media_page_blocker 也统一拒绝，两侧必须一致 —— 否则
  // 弹窗还会显示「解析并下载」按钮，点了只会得到一条必然失败的提示。
  const isDouyin =
    host === "douyin.com" || host.endsWith(".douyin.com") ||
    host === "iesdouyin.com" || host.endsWith(".iesdouyin.com");
  if (isDouyin) return true;

  // 明显的聚合页：首页、发现页、推荐页、精选页（无具体视频 id）。
  const AGGREGATE = /^\/?$|^\/(jingxuan|discover|new-reco|hot|feed|recommend|explore|home|index|user|profile)(\/|$)/i;
  return AGGREGATE.test(path);
}

function isVideoPage(url) {
  if (!/^https?:/i.test(url) || isDirectMediaFile(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const inList = VIDEO_HOSTS.some((h) => host === h || host.endsWith("." + h));
    return inList && !isUnsupportedPage(url);
  } catch {
    return false;
  }
}

/** 页面不支持整页解析时，给弹窗一句可操作指引；支持时返回空串。 */
function pageHint(url) {
  if (!/^https?:/i.test(url) || isDirectMediaFile(url) || isVideoPage(url)) return "";
  try {
    const host = new URL(url).hostname.toLowerCase();
    const inList = VIDEO_HOSTS.some((h) => host === h || host.endsWith("." + h));
    if (!inList) return "";
    const isKs =
      host === "kuaishou.com" || host.endsWith(".kuaishou.com") ||
      host === "kwai.com" || host.endsWith(".kwai.com");
    if (isKs) {
      return "内置解析器不支持快手网页链接。请在下方「本页资源」中选择视频直链下载；若列表为空，说明该页面只提供分片流，需打开单个视频页或换用其它来源。";
    }
    const isDouyin =
      host === "douyin.com" || host.endsWith(".douyin.com") ||
      host === "iesdouyin.com" || host.endsWith(".iesdouyin.com");
    if (isDouyin) {
      return "抖音网页解析需要浏览器下发的匿名校验 cookie，FluxDL 不读取、传输或保存任何凭证，因此不解析这类页面。请在下方「本页资源」中选择视频直链下载；若列表为空，说明该页面只提供分片流。";
    }
    return "这是站点首页 / 发现页 / 精选页，不是单个视频详情页，无法整页解析。请打开要下载的那个视频再试，或在下方「本页资源」中选择视频直链。";
  } catch {
    return "";
  }
}

/**
 * 从「本页资源」里挑出最可能是主视频的直链。
 *
 * 0.3.6：抖音 / 快手页面 yt-dlp 整页解析走不通（需要浏览器匿名校验 cookie /
 * 打包版没有快手提取器），但扩展往往已经嗅探到 video/mp4 整文件直链。真机
 * 截图里快手「本页资源」有两条 video/mp4（20.1 MB / 11.4 MB），用户却仍只能
 * 手动点列表，而主按钮还在把页面 URL 发成必然失败的 media 任务。
 * 这里按「视频 mime 或视频容器扩展名 → 体积降序」选一条，让弹窗主按钮直接
 * 按普通下载发送（不带 kind，桌面端会按 CDN 直链短路成 HTTP 任务）。
 */
const VIDEO_CONTAINER_EXT = /\.(mp4|m4v|mkv|webm|mov|flv|avi|ts)(?:[?#]|$)/i;

function isVideoResource(rec) {
  const url = String((rec && rec.url) || "");
  const mime = String((rec && rec.mime) || "").toLowerCase();
  return /^video\//.test(mime) || VIDEO_CONTAINER_EXT.test(url.split(/[?#]/)[0]);
}

function bestVideoResource(resources) {
  const list = (Array.isArray(resources) ? resources : []).filter((r) => {
    const url = String((r && r.url) || "");
    return /^https?:/i.test(url) && !STREAM_EXT.test(url) && isVideoResource(r);
  });
  // 正片通常体积最大；体积未知（0）排在有明确体积的后面，但仍可作为兜底。
  // 次级键：探针上报的记录没有响应头、体积全是 0，若只按体积排序就等于让
  // addResource 的 LIFO 插入顺序决定主按钮目标 —— 最后上报的播放 API
  // （aweme/.../play/?mime_type=video_mp4）会压过明确的 .mp4 容器直链。
  // 体积相同时优先「URL path 带容器扩展名」的直链，保证选择确定且更可下载。
  const rank = (r) => (VIDEO_CONTAINER_EXT.test(String((r && r.url) || "").split(/[?#]/)[0]) ? 0 : 1);
  list.sort((a, b) => {
    const bySize = (Number(b.size) || 0) - (Number(a.size) || 0);
    return bySize !== 0 ? bySize : rank(a) - rank(b);
  });
  return list[0] || null;
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split("/").pop() || "") || u.hostname;
  } catch {
    return String(url).slice(0, 80);
  }
}

function nameFromDisposition(cd) {
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : "";
}

/** 判定一个响应：流媒体分片 / 可下载文件 / 忽略 */
function classify(url, headers) {
  const mime = headerValue(headers, "content-type")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const cd = headerValue(headers, "content-disposition");

  // 0.3.6：PWA manifest / 站点配置等不是可下载资源。真机截图里
  // manifest.webmanifest（486 B，application/vnd.*）曾被下面的 application
  // 规则误收进「本页资源」列表。只影响列表展示，不影响自动接管浏览器下载。
  if (
    /\.(webmanifest|manifest|json|map)(\?|#|$)/i.test(url) &&
    !/attachment/i.test(cd) &&
    !/^(video|audio)\//.test(mime)
  ) {
    return null;
  }

  // DASH / HLS 分片与清单：不列为文件，只标记「本页有视频」。
  if (
    STREAM_EXT.test(url) ||
    /^(application\/dash\+xml|application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/mpegurl)$/.test(
      mime,
    )
  ) {
    return "stream";
  }
  if (/^(video|audio)\//.test(mime) || FILE_EXT.test(url)) return "file";
  if (/attachment/i.test(cd)) return "file";
  if (
    /^application\//.test(mime) &&
    /(zip|rar|7z|octet-stream|pdf|msword|vnd\.|x-iso|x-tar|x-gzip|x-bzip|x-xz|epub|android)/.test(
      mime,
    )
  ) {
    return "file";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 0.3.7 候选：MAIN-world 探针上报的资源
 *
 * webRequest 只能看到「已经发起的请求」，抖音 / 快手把真实直链藏在 XHR 返回的
 * JSON body 里、或通过 Blob / MediaSource 播放时，响应头里根本没有那条 mp4。
 * page-probe.js（MAIN world）会读页面自己的响应文本，把藏在 JSON / 内联脚本 /
 * HLS 清单里的 http(s) 直链经 probe-bridge.js 转发到这里。
 *
 * 判定规则不另起一套：构造一个最小的 content-type 头，直接复用上面的
 * classify()。这样 PWA manifest 噪声过滤、stream/file 判定、三处规则一致性
 * 全部沿用既有实现，探针与 webRequest 殊途同归。
 * ------------------------------------------------------------------ */

/** 探针没有响应头，只能按 URL 扩展名推断 content-type（仅用于喂给 classify）。 */
function inferProbeMime(url) {
  const full = String(url);
  const path = full.split(/[?#]/)[0].toLowerCase();
  if (/\.m3u8$/.test(path)) return "application/vnd.apple.mpegurl";
  if (/\.mpd$/.test(path)) return "application/dash+xml";
  // 分片 / 密钥不是完整视频：不编造 video/* mime，否则 classify 会误收成 file。
  if (PROBE_SEGMENT_EXT.test(path)) return "";
  if (/\.(mp4|m4v|mkv|webm|mov|flv|avi)$/.test(path)) return "video/mp4";
  if (/\.(mp3|m4a|aac|flac|wav|ogg|opus)$/.test(path)) return "audio/mpeg";
  // 与 page-probe.js 的 VIDEO_MIME_HINT 同一规则：抖音 / 快手无扩展名直链。
  if (/[?&](?:mime_?type|mime|media_?type|content_?type)=video/i.test(full)) {
    return "video/mp4";
  }
  return "";
}

/** 权威判定：与 webRequest 共用 classify，返回 "file" / "stream" / null。 */
function probeResourceKind(url) {
  const path = String(url).split(/[?#]/)[0];
  // 必须放在 classify 之前：classify 的 STREAM_EXT 含 m4s、FILE_EXT 含 m2ts，
  // 直接喂进去会把分片误判成 stream / file。与 page-probe.js 的 SEGMENT_EXT 一致。
  if (PROBE_SEGMENT_EXT.test(path)) return null;
  const mime = inferProbeMime(url);
  const headers = mime ? [{ name: "content-type", value: mime }] : [];
  return classify(url, headers);
}

/* ------------------------------------------------------------------ *
 * 本页资源缓存（按标签页）
 *
 * 注意：storage.session 的「读 → 改 → 写」之间跨了 await，MV3 事件循环里
 * 同一页面多个响应几乎同时到达时，几个 addResource 会各自读到同一份旧列表，
 * 后写的把先写的整份覆盖掉，表现为资源随机少几个甚至全丢。
 * 这里用一条 Promise 链把所有读改写串行化。
 * ------------------------------------------------------------------ */

let resourceQueue = Promise.resolve();

function enqueueResourceOp(fn) {
  resourceQueue = resourceQueue.then(fn).catch(() => {});
  return resourceQueue;
}

async function addResource(tabId, record) {
  return enqueueResourceOp(async () => {
    const key = `res:${tabId}`;
    const data = await chrome.storage.session.get(key);
    const list = Array.isArray(data[key]) ? data[key] : [];
    if (list.some((x) => x.url === record.url)) return;
    const next = [record, ...list].slice(0, MAX_RESOURCES);
    await chrome.storage.session.set({ [key]: next });
    try {
      await chrome.action.setBadgeText({ tabId, text: String(next.length) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2f6df6" });
    } catch {
      // 低版本 Chrome 不支持 badge 时忽略
    }
  });
}

async function markStream(tabId) {
  return enqueueResourceOp(() =>
    chrome.storage.session.set({ [`stream:${tabId}`]: true }),
  );
}

async function clearTab(tabId) {
  return enqueueResourceOp(async () => {
    await chrome.storage.session.remove([`res:${tabId}`, `stream:${tabId}`]);
    try {
      await chrome.action.setBadgeText({ tabId, text: "" });
    } catch {
      // 忽略
    }
  });
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    const tabId = details.tabId;
    if (typeof tabId !== "number" || tabId < 0) return;
    const url = details.url || "";
    if (!/^https?:/i.test(url) || url.startsWith(API)) return;

    const headers = details.responseHeaders || [];
    const kind = classify(url, headers);
    if (!kind) return;
    if (kind === "stream") {
      void markStream(tabId);
      return;
    }

    const size = Number(headerValue(headers, "content-length")) || 0;
    const name =
      nameFromDisposition(headerValue(headers, "content-disposition")) ||
      nameFromUrl(url);
    void addResource(tabId, {
      url,
      name,
      size,
      mime: headerValue(headers, "content-type").split(";")[0].trim(),
      referer: details.initiator || "",
      at: Date.now(),
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

// 记住每个标签页最后一次提交的 URL：Chrome 对同一次导航会重复派发
// onUpdated，若每次都 clearTab，会把刚嗅探到的资源又清掉。
const lastNavUrl = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  lastNavUrl.delete(tabId);
  void clearTab(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (lastNavUrl.get(tabId) === changeInfo.url) return;
  lastNavUrl.set(tabId, changeInfo.url);
  void clearTab(tabId);
});

/* ------------------------------------------------------------------ *
 * 右键菜单：只保留「链接」与「媒体」，删掉「下载当前页面」
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "用 FluxDL 下载此链接",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: MENU_MEDIA,
      title: "用 FluxDL 下载此媒体",
      contexts: ["video", "audio"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  let url = "";
  if (info.menuItemId === MENU_LINK) url = info.linkUrl;
  else if (info.menuItemId === MENU_MEDIA) url = info.srcUrl;
  if (!url || !/^https?:/i.test(url)) return;
  void sendToFluxDL({ url, referer: info.pageUrl }).catch(() => {});
});

/* ------------------------------------------------------------------ *
 * 桌面端通信
 * ------------------------------------------------------------------ */

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // 默认开启；只有用户显式关掉才是 false。
  return { autoCapture: stored.autoCapture !== false };
}

async function postDownload(payload) {
  const response = await fetch(`${API}/api/downloads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fluxdl-token": TOKEN,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function sendToFluxDL(payload, options = {}) {
  const { silent = false } = options;
  try {
    // 0.3.0 起不再采集任何 cookie：登录态一律不出浏览器，
    // 桌面端也不会在磁盘上留下凭证文件。
    // CaptureRequest 走 serde rename_all="camelCase"，这里必须是 userAgent；
    // 0.3.3 写成 user_agent 会被静默忽略，防盗链站点因此 403。
    const data = await postDownload({ ...payload, userAgent: navigator.userAgent });
    if (!silent) {
      notify("已发送到 FluxDL", payload.filename || payload.url, false);
    }
    return data;
  } catch (error) {
    if (!silent) {
      notify("FluxDL 未运行", "请先启动 FluxDL 桌面端，然后重试。", true);
    }
    throw error;
  }
}

function notify(title, message, isError) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/128.png"),
      title,
      message: message || "",
      priority: isError ? 2 : 0,
    });
  } catch {
    // 通知权限被拒绝时静默失败
  }
}

// 缓存健康检查结果，避免每个下载都探测一次端口。
let healthCache = { at: 0, ok: false };

async function fluxdlIsRunning() {
  const now = Date.now();
  if (now - healthCache.at < 5000) return healthCache.ok;
  let ok = false;
  try {
    const response = await fetch(`${API}/api/health`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    ok = response.ok && Boolean(data.ok);
  } catch {
    ok = false;
  }
  healthCache = { at: now, ok };
  return ok;
}

/* ------------------------------------------------------------------ *
 * 自动接管浏览器下载（无任何范围限制）
 * ------------------------------------------------------------------ */

function filenameFromPath(path) {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function stripDedupSuffix(name) {
  return name
    .replace(/\s*\(\d+\)(?=\.[^.]*$)/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim();
}

const GENERIC_STEMS = new Set([
  "download", "downloadfile", "getfile", "get", "file", "index",
  "unnamed", "attachment",
]);

function looksGeneric(name) {
  const dot = name.lastIndexOf(".");
  const stem = (dot === -1 ? name : name.slice(0, dot)).toLowerCase().trim();
  return !stem || GENERIC_STEMS.has(stem);
}

function suggestedFilename(item) {
  const raw = filenameFromPath(item.filename) || nameFromUrl(item.url || "");
  const cleaned = stripDedupSuffix(raw);
  return looksGeneric(cleaned) ? "" : cleaned;
}

/**
 * 只保留一个总开关，不做扩展名 / 体积 / 类型判断。
 * 「接管范围」设置已移除：所有 http(s) 下载一律交给 FluxDL。
 */
function shouldCapture(item, settings) {
  if (!settings.autoCapture) return false;
  const url = item.finalUrl || item.url || "";
  return /^https?:/i.test(url);
}

const inflight = new Set();
const recentUrls = new Map();

chrome.downloads.onCreated.addListener(async (item) => {
  if (!item || inflight.has(item.id)) return;
  const url = item.finalUrl || item.url || "";
  if (!/^https?:/i.test(url)) return;

  const now = Date.now();
  if (now - (recentUrls.get(url) || 0) < 3000) return;
  if (recentUrls.size > 200) recentUrls.clear();
  recentUrls.set(url, now);

  inflight.add(item.id);
  try {
    const settings = await loadSettings();
    if (!shouldCapture(item, settings)) return;
    if (!(await fluxdlIsRunning())) return;

    const data = await sendToFluxDL(
      {
        url,
        filename: suggestedFilename(item),
        referer: item.referrer,
        // UA 由 sendToFluxDL 统一注入，字段名必须与 Rust 的 camelCase 契约一致
      },
      { silent: true },
    );

    if (data && data.ok) {
      // 桌面端确认入队后才打断浏览器下载；任何异常都保留浏览器原有下载。
      try {
        await chrome.downloads.cancel(item.id);
      } catch {
        // 可能已经完成
      }
      try {
        await chrome.downloads.removeFile(item.id);
      } catch {
        // 文件可能尚未落盘
      }
      try {
        await chrome.downloads.erase({ id: item.id });
      } catch {
        // 忽略
      }
    }
  } catch {
    // 接收失败时不做任何打断
  } finally {
    setTimeout(() => inflight.delete(item.id), 4000);
  }
});

/* ------------------------------------------------------------------ *
 * 弹窗消息
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    switch (message && message.type) {
      case "probeResources": {
        // 0.3.7 候选：MAIN-world 探针发现的直链。tabId 只信 sender.tab（浏览器
        // 注入的 Content Script 上下文），绝不信消息体自带的 tabId —— 页面脚本
        // 可以伪造 postMessage，但伪造不了 sender。
        const tabId = sender && sender.tab && typeof sender.tab.id === "number"
          ? sender.tab.id
          : -1;
        if (tabId < 0) return { ok: false, error: "无法确定来源标签页" };
        const urls = Array.isArray(message.urls) ? message.urls : [];
        const pageUrl = typeof message.pageUrl === "string" ? message.pageUrl : "";
        const referer = pageUrl || (sender.tab && sender.tab.url) || "";
        let added = 0;
        let streams = 0;
        const ops = [];
        for (let i = 0; i < urls.length && i < 48; i += 1) {
          const url = String(urls[i] || "");
          if (!/^https?:/i.test(url) || url.startsWith(API)) continue;
          // 第三道校验：拒绝带 user:pass@ 的 URL（凭证红线）
          try {
            const parsed = new URL(url);
            if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) continue;
          } catch {
            continue;
          }
          const kind = probeResourceKind(url);
          if (!kind) continue;
          if (kind === "stream") {
            streams += 1;
            ops.push(markStream(tabId));
            continue;
          }
          ops.push(addResource(tabId, {
            url,
            name: nameFromUrl(url),
            size: 0,                 // 探针无响应头，体积未知；bestVideo 会把它排在有体积的之后
            mime: inferProbeMime(url),
            referer,
            at: Date.now(),
            via: "probe",           // 标记来源，便于弹窗排查
          }));
          added += 1;
        }
        await Promise.all(ops);
        return { ok: true, added, streams };
      }
      case "getPageResources": {
        if (!tab) {
          return {
            tab: null, resources: [], hasStream: false,
            pageIsVideo: false, pageHint: "", bestVideo: null,
          };
        }
        const key = `res:${tab.id}`;
        const skey = `stream:${tab.id}`;
        const data = await chrome.storage.session.get([key, skey]);
        const rawUrl = tab.url || "";
        const resources = Array.isArray(data[key]) ? data[key] : [];
        return {
          tab: { id: tab.id, url: rawUrl, title: tab.title || "" },
          resources,
          hasStream: Boolean(data[skey]),
          pageIsVideo: isVideoPage(rawUrl),
          pageHint: pageHint(rawUrl),
          bestVideo: bestVideoResource(resources),
        };
      }
      case "clearPageResources": {
        if (tab) await clearTab(tab.id);
        return { ok: true };
      }
      case "sendDownload": {
        const data = await sendToFluxDL(message.payload || {}, {
          silent: message.silent === true,
        });
        return { ok: true, data };
      }
      default:
        return { ok: false };
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true; // 异步响应
});

// 供 Node 侧单元测试复用核心纯函数（service worker 里 module 未定义，不会执行）
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    classify,
    shouldCapture,
    isVideoPage,
    isDirectMediaFile,
    isVideoResource,
    bestVideoResource,
    inferProbeMime,
    probeResourceKind,
    pageHint,
    nameFromDisposition,
    nameFromUrl,
    suggestedFilename,
  };
}
