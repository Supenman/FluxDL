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

function isVideoPage(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return VIDEO_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
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
    const data = await postDownload(payload);
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
        user_agent: navigator.userAgent,
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    switch (message && message.type) {
      case "getPageResources": {
        if (!tab) {
          return { tab: null, resources: [], hasStream: false, pageIsVideo: false };
        }
        const key = `res:${tab.id}`;
        const skey = `stream:${tab.id}`;
        const data = await chrome.storage.session.get([key, skey]);
        return {
          tab: { id: tab.id, url: tab.url || "", title: tab.title || "" },
          resources: Array.isArray(data[key]) ? data[key] : [],
          hasStream: Boolean(data[skey]),
          pageIsVideo: isVideoPage(tab.url || ""),
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
    nameFromDisposition,
    nameFromUrl,
    suggestedFilename,
    needsCookies,
    netscapeCookies,
    COOKIE_DOMAINS,
  };
}
