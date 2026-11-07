const API = "http://127.0.0.1:35917";
const DEFAULT_SETTINGS = { autoCapture: true };

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const hint = document.getElementById("hint");
const autoCapture = document.getElementById("auto-capture");
const recheck = document.getElementById("recheck");

const videoCard = document.getElementById("video-card");
const videoTip = document.getElementById("video-tip");
const parseVideo = document.getElementById("parse-video");
const resCount = document.getElementById("res-count");
const resList = document.getElementById("res-list");
const clearRes = document.getElementById("clear-res");
const downloadAll = document.getElementById("download-all");

let current = {
  tab: null, resources: [], hasStream: false,
  pageIsVideo: false, pageHint: "", bestVideo: null,
};

function setStatus(state) {
  statusDot.className = "dot " + state;
  if (state === "online") {
    statusText.textContent = "已连接 FluxDL 桌面端";
    hint.textContent = "浏览页面时自动收集资源；也可在链接或视频上右键直接发送。";
    hint.classList.remove("warn");
  } else if (state === "offline") {
    statusText.textContent = "未连接 · 请先启动 FluxDL";
    hint.textContent = "启动 FluxDL 桌面端后点「重新检测」，即可开始捕获。";
    hint.classList.add("warn");
  } else {
    statusText.textContent = "正在检测桌面端…";
  }
}

async function checkHealth() {
  setStatus("pending");
  try {
    const response = await fetch(`${API}/api/health`, { cache: "no-store" });
    const data = await response.json();
    setStatus(response.ok && data.ok ? "online" : "offline");
  } catch {
    setStatus("offline");
  }
}

async function loadPrefs() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  autoCapture.checked = stored.autoCapture !== false;
}

function savePrefs() {
  chrome.storage.sync.set({ autoCapture: autoCapture.checked });
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function kindLabel(rec) {
  const mime = (rec.mime || "").toLowerCase();
  if (mime.startsWith("video/")) return "视频";
  if (mime.startsWith("audio/")) return "音频";
  const ext = (rec.name || "").split(".").pop().toLowerCase();
  if (/^(zip|rar|7z|tar|gz|bz2|xz|zst|tgz)$/.test(ext)) return "压缩包";
  if (/^(exe|msi|msix|appx|apk|deb|rpm|pkg)$/.test(ext)) return "安装包";
  if (/^(pdf|docx?|xlsx?|pptx?|epub|mobi|txt)$/.test(ext)) return "文档";
  return "文件";
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response || {}));
  });
}

async function sendDownload(payload) {
  const result = await sendMessage({ type: "sendDownload", payload, silent: false });
  if (result.ok === false) {
    hint.textContent = `发送失败：${result.error || "桌面端未响应"}`;
    hint.classList.add("warn");
  }
  return result;
}

function renderResources() {
  const list = current.resources || [];
  resCount.textContent = String(list.length);
  resList.textContent = "";

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "res-empty";
    empty.textContent = "还没有嗅探到资源。刷新页面，或打开一个含视频 / 附件的页面。";
    resList.appendChild(empty);
    downloadAll.hidden = true;
    return;
  }

  for (const rec of list) {
    const row = document.createElement("div");
    row.className = "res-row";

    const badge = document.createElement("span");
    badge.className = "res-badge";
    badge.textContent = kindLabel(rec);

    const info = document.createElement("div");
    info.className = "res-info";
    const name = document.createElement("span");
    name.className = "res-name";
    name.textContent = rec.name || rec.url;
    name.title = rec.url;
    const meta = document.createElement("small");
    meta.textContent = `${formatSize(rec.size)} · ${rec.mime || "未知类型"}`;
    info.appendChild(name);
    info.appendChild(meta);

    const btn = document.createElement("button");
    btn.className = "res-btn";
    btn.textContent = "下载";
    btn.addEventListener("click", () => {
      void sendDownload({
        url: rec.url,
        filename: rec.name,
        referer: rec.referer || (current.tab && current.tab.url) || "",
      });
    });

    row.appendChild(badge);
    row.appendChild(info);
    row.appendChild(btn);
    resList.appendChild(row);
  }
  downloadAll.hidden = false;
}

function renderVideoCard() {
  const advice = current.pageHint || "";
  const best = current.bestVideo || null;
  const show = Boolean(current.pageIsVideo || current.hasStream || advice);
  videoCard.hidden = !show;
  if (!show) return;
  const titleEl = videoCard.querySelector(".copy > span");

  if (!advice) {
    // 正常视频站点：整页交给桌面端 yt-dlp 解析清晰度并合并音视频。
    if (titleEl) titleEl.textContent = "本页检测到视频";
    parseVideo.hidden = false;
    parseVideo.textContent = "解析并下载本页视频";
    videoTip.textContent = current.hasStream
      ? "检测到流媒体分片，交给桌面端 yt-dlp 解析并合并音视频"
      : "视频站点页面，交给桌面端 yt-dlp 解析清晰度并下载";
    return;
  }

  // 0.3.6：整页解析不可用（快手网页 / 抖音 cookie 门槛 / 首页发现页）。
  // 不再把页面 URL 发成必然失败的 media 任务；嗅探到视频直链时主按钮直接
  // 按普通下载发送，否则只给可操作指引并隐藏按钮。
  if (titleEl) titleEl.textContent = "整页解析不可用";
  if (best) {
    parseVideo.hidden = false;
    parseVideo.textContent = `下载本页视频（${formatSize(best.size)} 直链）`;
    videoTip.textContent =
      "已嗅探到视频直链，点击即按普通下载发送；若清晰度不对，可在下方「本页资源」里另选。";
  } else {
    parseVideo.hidden = true;
    videoTip.textContent = advice;
  }
}

async function refreshResources() {
  const data = await sendMessage({ type: "getPageResources" });
  current = {
    tab: data.tab || null,
    resources: Array.isArray(data.resources) ? data.resources : [],
    hasStream: Boolean(data.hasStream),
    pageIsVideo: Boolean(data.pageIsVideo),
    pageHint: data.pageHint || "",
    bestVideo: data.bestVideo || null,
  };
  renderResources();
  renderVideoCard();
}

autoCapture.addEventListener("change", savePrefs);
recheck.addEventListener("click", () => {
  void checkHealth();
  void refreshResources();
});

parseVideo.addEventListener("click", () => {
  const advice = current.pageHint || "";
  if (advice) {
    // 整页解析不可用：只发送扩展嗅探到的视频直链，绝不发送页面 URL。
    // 不带 kind，桌面端按 CDN 容器直链短路成 HTTP 普通下载任务。
    const best = current.bestVideo;
    if (!best || !/^https?:/i.test(best.url)) return;
    void sendDownload({
      url: best.url,
      filename: best.name,
      referer: best.referer || (current.tab && current.tab.url) || "",
    });
    return;
  }
  const url = current.tab && current.tab.url;
  if (!url || !/^https?:/i.test(url)) return;
  void sendDownload({ url, kind: "media", referer: url });
});

clearRes.addEventListener("click", async () => {
  await sendMessage({ type: "clearPageResources" });
  await refreshResources();
});

downloadAll.addEventListener("click", () => {
  for (const rec of current.resources) {
    void sendDownload({
      url: rec.url,
      filename: rec.name,
      referer: rec.referer || (current.tab && current.tab.url) || "",
    });
  }
});

void loadPrefs();
void checkHealth();
void refreshResources();
