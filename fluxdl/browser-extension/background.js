const API = "http://127.0.0.1:35917";
const TOKEN = "fluxdl-local-v1";
const MENU_LINK = "fluxdl-download-link";
const MENU_PAGE = "fluxdl-download-page";

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

async function isAutoCaptureEnabled() {
  const stored = await chrome.storage.sync.get({ autoCapture: true });
  return Boolean(stored.autoCapture);
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

const SKIP_EXTENSIONS = new Set(["html", "htm", "php", "asp", "aspx", "jsp"]);

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

const inflight = new Set();

chrome.downloads.onCreated.addListener(async (item) => {
  if (!item || inflight.has(item.id)) return;
  const url = item.finalUrl || item.url || "";
  if (!/^https?:/i.test(url)) return;
  const ext = extensionOf(url);
  if (SKIP_EXTENSIONS.has(ext)) return;

  inflight.add(item.id);
  try {
    if (!(await isAutoCaptureEnabled())) return;
    if (!(await fluxdlIsRunning())) return;

    const filename = filenameFromPath(item.filename) || filenameFromUrl(url);
    const data = await sendToFluxDL(
      { url, filename, referer: item.referrer },
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
