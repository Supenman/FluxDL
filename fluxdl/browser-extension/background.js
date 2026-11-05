const API = "http://127.0.0.1:35917";
const TOKEN = "fluxdl-local-v1";
const MENU_LINK = "fluxdl-download-link";
const MENU_PAGE = "fluxdl-download-page";

const DEFAULT_SETTINGS = {
  autoCapture: true,
  groups: {
    archive: true,
    installer: true,
    media: true,
    doc: true,
    image: false,
  },
  minSizeMB: 1,
};

// 只有命中这些扩展名才会自动接管，其余一律留给浏览器。
const GROUP_EXTENSIONS = {
  archive: [
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz", "txz",
    "cab", "iso", "dmg", "img",
  ],
  installer: ["exe", "msi", "msix", "appx", "apk", "deb", "rpm", "pkg", "dmg"],
  media: [
    "mp4", "mkv", "webm", "avi", "mov", "flv", "ts", "m4v", "wmv", "mpg",
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "wma", "ape",
  ],
  doc: [
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
    "md", "epub", "mobi", "rtf", "odt", "ods", "odp",
  ],
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "tif", "tiff"],
};

const EXT_TO_GROUP = {};
for (const [group, list] of Object.entries(GROUP_EXTENSIONS)) {
  for (const ext of list) EXT_TO_GROUP[ext] = group;
}

const GENERIC_STEMS = new Set([
  "download",
  "downloadfile",
  "getfile",
  "get",
  "file",
  "index",
  "unnamed",
  "attachment",
]);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "用 FluxDL 下载此链接",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: "用 FluxDL 下载当前页面",
      contexts: ["page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
  if (!url || !/^https?:/i.test(url)) return;
  sendToFluxDL({
    url,
    referer: info.pageUrl,
  }).catch(() => {});
});

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    autoCapture: Boolean(stored.autoCapture),
    groups: { ...DEFAULT_SETTINGS.groups, ...(stored.groups || {}) },
    minSizeMB: Number(stored.minSizeMB) || 0,
  };
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

function extensionOf(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const dot = path.lastIndexOf(".");
    if (dot === -1) return "";
    return path.slice(dot + 1).split(/[?#]/)[0].slice(0, 8);
  } catch {
    return "";
  }
}

function extensionOfName(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase().split(/[?#]/)[0].slice(0, 8);
}

function filenameFromPath(path) {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    return name || "";
  } catch {
    return "";
  }
}

// Chrome 遇到同名文件会自动加 “ (1)”，那个后缀不是文件真名。
function stripDedupSuffix(name) {
  return name
    .replace(/\s*\(\d+\)(?=\.[^.]*$)/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim();
}

// 路径 /download、/get 这类名字没有信息量，交给桌面端按 Content-Disposition 或链接推断。
function looksGeneric(name) {
  const dot = name.lastIndexOf(".");
  const stem = (dot === -1 ? name : name.slice(0, dot)).toLowerCase().trim();
  return !stem || GENERIC_STEMS.has(stem);
}

function suggestedFilename(item) {
  const raw = filenameFromPath(item.filename) || filenameFromUrl(item.url);
  const cleaned = stripDedupSuffix(raw);
  return looksGeneric(cleaned) ? "" : cleaned;
}

function shouldCapture(item, settings) {
  if (!settings.autoCapture) return false;

  const name = filenameFromPath(item.filename) || filenameFromUrl(item.url);
  const ext = extensionOfName(name) || extensionOf(item.url);
  const group = EXT_TO_GROUP[ext];
  if (!group || !settings.groups[group]) return false;

  const mime = (item.mime || "").toLowerCase();
  if (mime.startsWith("text/html") || mime.startsWith("application/xhtml")) return false;

  const minBytes = (settings.minSizeMB || 0) * 1024 * 1024;
  if (minBytes > 0 && item.fileSize > 0 && item.fileSize < minBytes) return false;

  return true;
}

const inflight = new Set();

chrome.downloads.onCreated.addListener(async (item) => {
  if (!item || inflight.has(item.id)) return;
  const url = item.finalUrl || item.url || "";
  if (!/^https?:/i.test(url)) return;

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
    // FluxDL 接收失败时保留浏览器原有下载，不做任何打断。
  } finally {
    setTimeout(() => inflight.delete(item.id), 4000);
  }
});
