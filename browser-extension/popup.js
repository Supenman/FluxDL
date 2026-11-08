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

const resSearch = document.getElementById("res-search");
const resFilter = document.getElementById("res-filter");
const resSort = document.getElementById("res-sort");
const resSelectAll = document.getElementById("res-select-all");
const resDownloadSelected = document.getElementById("res-download-selected");
const resCopySelected = document.getElementById("res-copy-selected");
const resSummary = document.getElementById("res-summary");

let current = {
  tab: null, resources: [], hasStream: false,
  pageIsVideo: false, pageHint: "", bestVideo: null,
};

// 弹窗本地视图状态（不写入扩展存储，关闭即重置）
const view = {
  query: "",
  filter: "all",
  sort: "recent",
  selected: new Set(),
  expanded: new Set(),
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

function relativeTime(at) {
  if (!at) return "";
  const secs = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (secs < 10) return "刚刚";
  if (secs < 60) return `${secs} 秒前`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`;
  return `${Math.floor(secs / 86400)} 天前`;
}

function resourceState(rec) {
  const meta = rec && rec.meta;
  if (!meta) return rec.via === "probe" ? "checking" : "ok";
  if (meta.state === "dead") return "dead";
  if (meta.state === "ok") return "ok";
  return "unknown";
}

const STATE_TEXT = {
  ok: "可下载", dead: "已失效", unknown: "未校验", checking: "校验中",
};

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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 低版本 / 无焦点时的兜底，不引入任何额外权限
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * 本页资源里的 URL 都是「已经嗅探到的文件 / 视频直链」，不是网页地址。
 * 必须显式带 kind:"http" 走普通下载 —— 否则桌面端 handle_capture_conn 会用
 * looks_like_media(url) 兜底判定，而 is_direct_media_file 只认带 .mp4 等容器
 * 扩展名的直链；抖快探针嗅到的多是无扩展名直链（.../play/?mime_type=video_mp4），
 * 命中站点名单后被判成 Media 任务，再被 media_page_blocker 拒绝，点了没反应。
 */
function resourcePayload(rec) {
  return {
    url: rec.url,
    filename: rec.name,
    referer: rec.referer || (current.tab && current.tab.url) || "",
    kind: "http",
  };
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
    resDownloadSelected.hidden = true;
    resCopySelected.hidden = true;
    resSummary.textContent = "";
    return;
  }

  const q = view.query.trim().toLowerCase();
  const visible = list.filter((rec) => {
    if (view.filter !== "all" && kindLabel(rec) !== view.filter) return false;
    if (!q) return true;
    return `${rec.name || ""} ${rec.url || ""}`.toLowerCase().includes(q);
  });
  visible.sort((a, b) => {
    if (view.sort === "size") return (Number(b.size) || 0) - (Number(a.size) || 0);
    if (view.sort === "name") return String(a.name || "").localeCompare(String(b.name || ""));
    return (Number(b.at) || 0) - (Number(a.at) || 0);
  });

  // 清理已不存在的选中 / 展开项
  const urls = new Set(list.map((r) => r.url));
  for (const u of view.selected) if (!urls.has(u)) view.selected.delete(u);
  for (const u of view.expanded) if (!urls.has(u)) view.expanded.delete(u);

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "res-empty";
    empty.textContent = "没有匹配的资源，换个关键词或筛选条件试试。";
    resList.appendChild(empty);
  }

  for (const rec of visible) {
    const wrap = document.createElement("div");
    const state = resourceState(rec);
    wrap.className = "res-row-wrap" + (state === "dead" ? " dead" : "");

    const row = document.createElement("div");
    row.className = "res-main res-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "res-check";
    check.checked = view.selected.has(rec.url);
    check.disabled = state === "dead";
    check.addEventListener("change", () => {
      if (check.checked) view.selected.add(rec.url);
      else view.selected.delete(rec.url);
      renderResources();
    });

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
    const via = rec.via === "probe" ? "探针" : "响应头";
    const when = relativeTime(rec.at);
    const variants = Array.isArray(rec.variants) ? rec.variants.length : 0;
    meta.textContent = [
      formatSize(rec.size), rec.mime || "未知类型", via, when,
      variants ? `${variants} 个备用` : "",
    ].filter(Boolean).join(" · ");
    info.appendChild(name);
    info.appendChild(meta);

    const stateEl = document.createElement("span");
    stateEl.className = "res-state " + state;
    stateEl.textContent = STATE_TEXT[state];
    stateEl.title = state === "dead"
      ? "该直链已失效（404/410），请刷新页面重新嗅探"
      : state === "unknown"
        ? "无法校验（可能是防盗链或临时失败），仍可尝试下载"
        : "";

    const btn = document.createElement("button");
    btn.className = "res-btn";
    btn.textContent = "下载";
    btn.disabled = state === "dead";
    btn.title = state === "dead" ? "直链已失效" : "按普通下载发送到 FluxDL";
    btn.addEventListener("click", () => {
      if (state === "dead") return;
      void sendDownload(resourcePayload(rec));
    });

    const copy = document.createElement("button");
    copy.className = "res-copy";
    copy.textContent = "复制";
    copy.title = "复制直链地址";
    copy.addEventListener("click", async () => {
      const ok = await copyText(rec.url);
      hint.textContent = ok ? "直链已复制到剪贴板" : "复制失败，请手动选中地址复制";
      hint.classList.toggle("warn", !ok);
    });

    row.appendChild(check);
    row.appendChild(badge);
    row.appendChild(info);
    row.appendChild(stateEl);
    row.appendChild(copy);
    row.appendChild(btn);
    wrap.appendChild(row);

    // 归一化同组的备用地址：默认收起，按需展开选择具体镜像 / 清晰度
    const variantList = Array.isArray(rec.variants) ? rec.variants : [];
    if (variantList.length) {
      const toggle = document.createElement("button");
      toggle.className = "res-variants";
      toggle.textContent = view.expanded.has(rec.url)
        ? `收起 ${variantList.length} 个备用地址`
        : `展开 ${variantList.length} 个备用地址`;
      toggle.addEventListener("click", () => {
        if (view.expanded.has(rec.url)) view.expanded.delete(rec.url);
        else view.expanded.add(rec.url);
        renderResources();
      });
      wrap.appendChild(toggle);

      if (view.expanded.has(rec.url)) {
        const box = document.createElement("div");
        box.className = "res-variant-list";
        for (const v of variantList) {
          const line = document.createElement("div");
          line.className = "res-variant";
          const label = document.createElement("span");
          label.textContent = `${v.name || v.url} · ${formatSize(v.size)}`;
          label.title = v.url;
          const vBtn = document.createElement("button");
          vBtn.className = "res-btn";
          vBtn.textContent = "下载";
          vBtn.addEventListener("click", () => {
            void sendDownload(resourcePayload({ ...rec, url: v.url, name: v.name || rec.name }));
          });
          line.appendChild(label);
          line.appendChild(vBtn);
          box.appendChild(line);
        }
        wrap.appendChild(box);
      }
    }

    resList.appendChild(wrap);
  }

  downloadAll.hidden = false;
  resDownloadSelected.hidden = view.selected.size === 0;
  resCopySelected.hidden = view.selected.size === 0;

  const dead = list.filter((r) => resourceState(r) === "dead").length;
  const parts = [`显示 ${visible.length} / ${list.length} 条`];
  if (view.selected.size) parts.push(`已选 ${view.selected.size} 条`);
  if (dead) parts.push(`${dead} 条直链已失效`);
  resSummary.textContent = parts.join(" · ");
  resSummary.classList.toggle("warn", dead > 0);
  if (dead) {
    resSummary.title = "失效直链多为带时效签名的地址，刷新页面可重新嗅探到新的直链";
  }
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

  // 整页解析不可用（快手网页 / 抖音 cookie 门槛 / 首页发现页）。
  // 不再把页面 URL 发成必然失败的 media 任务；嗅探到视频直链时主按钮直接
  // 按普通下载发送（显式 kind:"http"），否则只给可操作指引并隐藏按钮。
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

/** 重新检测：强制重探未校验 / 已过期的直链，稍后刷新列表显示结果。 */
async function recheckMetadata() {
  await sendMessage({ type: "refreshMetadata" });
  await refreshResources();
  // HEAD 探测是异步写回缓存的，给一次短延迟再拉一遍，让状态与体积落到 UI 上
  setTimeout(() => { void refreshResources(); }, 1400);
  setTimeout(() => { void refreshResources(); }, 3000);
}

autoCapture.addEventListener("change", savePrefs);
recheck.addEventListener("click", () => {
  void checkHealth();
  void recheckMetadata();
});

parseVideo.addEventListener("click", () => {
  const advice = current.pageHint || "";
  if (advice) {
    // 整页解析不可用：只发送扩展嗅探到的视频直链（resourcePayload 显式 http）。
    const best = current.bestVideo;
    if (!best || !/^https?:/i.test(best.url)) return;
    void sendDownload(resourcePayload(best));
    return;
  }
  const url = current.tab && current.tab.url;
  if (!url || !/^https?:/i.test(url)) return;
  void sendDownload({ url, kind: "media", referer: url });
});

clearRes.addEventListener("click", async () => {
  await sendMessage({ type: "clearPageResources" });
  view.selected.clear();
  view.expanded.clear();
  await refreshResources();
});

downloadAll.addEventListener("click", () => {
  for (const rec of current.resources) {
    if (resourceState(rec) === "dead") continue;
    void sendDownload(resourcePayload(rec));
  }
});

resDownloadSelected.addEventListener("click", () => {
  for (const rec of current.resources) {
    if (!view.selected.has(rec.url) || resourceState(rec) === "dead") continue;
    void sendDownload(resourcePayload(rec));
  }
});

resCopySelected.addEventListener("click", async () => {
  const urls = current.resources
    .filter((rec) => view.selected.has(rec.url))
    .map((rec) => rec.url);
  if (!urls.length) return;
  const ok = await copyText(urls.join("\n"));
  hint.textContent = ok ? `已复制 ${urls.length} 条直链` : "复制失败，请手动选中地址复制";
  hint.classList.toggle("warn", !ok);
});

resSelectAll.addEventListener("click", () => {
  const q = view.query.trim().toLowerCase();
  const candidates = current.resources.filter((rec) => {
    if (resourceState(rec) === "dead") return false;
    if (view.filter !== "all" && kindLabel(rec) !== view.filter) return false;
    return !q || `${rec.name || ""} ${rec.url || ""}`.toLowerCase().includes(q);
  });
  const allSelected = candidates.length > 0 && candidates.every((r) => view.selected.has(r.url));
  for (const rec of candidates) {
    if (allSelected) view.selected.delete(rec.url);
    else view.selected.add(rec.url);
  }
  renderResources();
});

resSearch.addEventListener("input", () => {
  view.query = resSearch.value || "";
  renderResources();
});
resFilter.addEventListener("change", () => {
  view.filter = resFilter.value || "all";
  renderResources();
});
resSort.addEventListener("change", () => {
  view.sort = resSort.value || "recent";
  renderResources();
});

void loadPrefs();
void checkHealth();
void refreshResources();
// 打开弹窗时对未校验 / 过期的直链补一次轻量探测，随后状态会落到列表上
void recheckMetadata();
