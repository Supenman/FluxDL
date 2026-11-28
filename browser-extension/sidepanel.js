(function () {
  "use strict";

  const statusEl = document.getElementById("sp-status");
  const scanBtn = document.getElementById("sp-scan");
  const deepBtn = document.getElementById("sp-deep");
  const fullBtn = document.getElementById("sp-open-full");
  const catsEl = document.getElementById("sp-cats");
  const queryEl = document.getElementById("sp-query");
  const minEl = document.getElementById("sp-min");
  const selAllBtn = document.getElementById("sp-sel-all");
  const gridEl = document.getElementById("sp-grid");
  const folderEl = document.getElementById("sp-folder");
  const browserDlBtn = document.getElementById("sp-browser-dl");
  const sendBtn = document.getElementById("sp-send");
  const toastEl = document.getElementById("sp-toast");

  const CAT_SHORT = { main: "主图", sku: "SKU", detail: "详情", review: "评论" };

  let currentTab = null;
  let allImages = [];
  let selected = new Set();
  let activeCat = "all";
  let toastTimer = null;

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
  }

  function sanitizeName(str) {
    return String(str || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  }

  function buildSubdir(item) {
    const mode = folderEl.value;
    if (mode === "none") return "";
    const pageFolder = sanitizeName((currentTab && currentTab.title) || "FluxDL图片") || "FluxDL图片";
    if (mode === "title") return pageFolder;
    const cat = item.category && CAT_SHORT[item.category] ? CAT_SHORT[item.category] : "其他";
    return `${pageFolder}/${cat}`;
  }

  function visibleImages() {
    const q = queryEl.value.trim().toLowerCase();
    const minPx = Number(minEl.value) || 0;
    return allImages.filter((item) => {
      if (item.broken) return false;
      if (activeCat !== "all" && (item.category || "other") !== activeCat) return false;
      const edge = Math.max(item.width || 0, item.height || 0);
      if (minPx > 0 && edge > 0 && edge < minPx) return false;
      if (q) {
        const hay = `${item.filename || ""} ${item.url || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function syncButtons(vis) {
    const visSet = new Set(vis.map((i) => i.url));
    for (const u of Array.from(selected)) {
      if (!visSet.has(u)) selected.delete(u);
    }
    const n = selected.size;
    sendBtn.disabled = n === 0;
    browserDlBtn.disabled = n === 0;
    sendBtn.textContent = `发往 FluxDL (${n})`;
    selAllBtn.textContent = vis.length > 0 && n === vis.length ? "全不选" : "全选";
  }

  function render() {
    const vis = visibleImages();
    syncButtons(vis);
    gridEl.textContent = "";

    if (!vis.length) {
      const empty = document.createElement("div");
      empty.className = "sp-empty";
      empty.textContent = allImages.length === 0
        ? "暂无图片，请点击「扫描本页」（若刚重载扩展，请先刷新网页）。"
        : "当前筛选条件下没有图片。";
      gridEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of vis) {
      const card = document.createElement("div");
      card.className = "sp-card" + (selected.has(item.url) ? " is-selected" : "");

      const thumb = document.createElement("div");
      thumb.className = "sp-thumb";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "sp-cb";
      cb.checked = selected.has(item.url);

      const img = document.createElement("img");
      img.src = item.previewUrl || item.url;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";

      const badges = document.createElement("div");
      badges.className = "sp-badges";
      if (item.category && CAT_SHORT[item.category]) {
        const b = document.createElement("span");
        b.className = `badge cat-${item.category}`;
        b.textContent = CAT_SHORT[item.category];
        badges.appendChild(b);
      }
      if (item.upgraded) {
        const hd = document.createElement("span");
        hd.className = "badge hd";
        hd.textContent = "HD";
        badges.appendChild(hd);
      }

      thumb.appendChild(cb);
      thumb.appendChild(img);
      thumb.appendChild(badges);

      const meta = document.createElement("div");
      meta.className = "sp-meta";
      const dimEl = document.createElement("span");
      dimEl.textContent = item.width && item.height ? `${item.width}×${item.height}` : "探测中";
      const nameEl = document.createElement("span");
      nameEl.textContent = item.filename || "image";
      meta.appendChild(dimEl);
      meta.appendChild(nameEl);

      img.addEventListener("load", () => {
        if (img.naturalWidth && img.naturalHeight) {
          if (!item.width || img.naturalWidth > item.width) {
            item.width = img.naturalWidth;
            item.height = img.naturalHeight;
            dimEl.textContent = `${item.width}×${item.height}`;
          }
        }
      });
      img.addEventListener("error", () => {
        if (item.upgraded && item.previewUrl && img.src !== item.previewUrl) {
          item.url = item.previewUrl;
          item.upgraded = false;
          img.src = item.previewUrl;
          return;
        }
        item.broken = true;
        card.remove();
        syncButtons(visibleImages());
      });

      const toggle = () => {
        if (selected.has(item.url)) selected.delete(item.url);
        else selected.add(item.url);
        cb.checked = selected.has(item.url);
        card.classList.toggle("is-selected", cb.checked);
        syncButtons(vis);
      };
      card.addEventListener("click", toggle);
      cb.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
      card.addEventListener("dblclick", () => {
        chrome.tabs.create({ url: item.url });
      });

      card.appendChild(thumb);
      card.appendChild(meta);
      frag.appendChild(card);
    }
    gridEl.appendChild(frag);
  }

  async function scanCurrentTab(autoScroll = false) {
    scanBtn.disabled = true;
    deepBtn.disabled = true;
    statusEl.textContent = autoScroll ? "正在深度滚动扫描…" : "正在扫描当前页…";
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tab || null;
      if (!tab || typeof tab.id !== "number" || !/^https?:/i.test(tab.url || "")) {
        allImages = [];
        selected.clear();
        statusEl.textContent = "请在普通 http/https 网页中使用";
        render();
        return;
      }
      const resp = await chrome.tabs.sendMessage(
        tab.id,
        { type: "scanPageImages", autoScroll },
        { frameId: 0 },
      );
      allImages = resp && Array.isArray(resp.images) ? resp.images : [];
      selected = new Set(visibleImages().map((i) => i.url));
      statusEl.textContent = `${(tab.title || "").slice(0, 18)} · 共 ${allImages.length} 张`;
      render();
    } catch {
      allImages = [];
      selected.clear();
      statusEl.textContent = "请先刷新当前网页（F5）后再点扫描";
      render();
    } finally {
      scanBtn.disabled = false;
      deepBtn.disabled = false;
    }
  }

  catsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".cat-pill[data-cat]");
    if (!btn) return;
    activeCat = btn.getAttribute("data-cat") || "all";
    catsEl.querySelectorAll(".cat-pill").forEach((p) => p.classList.toggle("active", p === btn));
    render();
  });

  queryEl.addEventListener("input", render);
  minEl.addEventListener("change", () => {
    selected = new Set(visibleImages().map((i) => i.url));
    render();
  });

  selAllBtn.addEventListener("click", () => {
    const vis = visibleImages();
    if (selected.size === vis.length) selected.clear();
    else selected = new Set(vis.map((i) => i.url));
    render();
  });

  scanBtn.addEventListener("click", () => void scanCurrentTab(false));
  deepBtn.addEventListener("click", () => void scanCurrentTab(true));
  fullBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "openImageGallery", scope: "current", autoScroll: false });
  });

  sendBtn.addEventListener("click", async () => {
    const picked = visibleImages().filter((i) => selected.has(i.url));
    if (!picked.length) return;
    sendBtn.disabled = true;
    let ok = 0;
    for (const item of picked) {
      if (!/^https?:/i.test(item.url || "")) continue;
      try {
        const res = await chrome.runtime.sendMessage({
          type: "sendDownload",
          silent: true,
          payload: {
            url: item.url,
            kind: "http",
            filename: item.filename,
            subdir: buildSubdir(item) || undefined,
            referer: item.referer,
          },
        });
        if (res && res.ok) ok += 1;
      } catch {}
    }
    showToast(`已发送 ${ok}/${picked.length} 张到 FluxDL`);
    syncButtons(visibleImages());
  });

  browserDlBtn.addEventListener("click", async () => {
    const picked = visibleImages().filter((i) => selected.has(i.url));
    if (!picked.length) return;
    browserDlBtn.disabled = true;
    const items = picked.map((item) => {
      const sub = buildSubdir(item);
      return {
        url: item.url,
        filename: sub ? `FluxDL/${sub}/${item.filename}` : `FluxDL/${item.filename}`,
      };
    });
    const resp = await chrome.runtime.sendMessage({ type: "browserDownloadImages", items });
    showToast(`已按文件夹保存 ${resp && resp.count ? resp.count : 0}/${picked.length} 张`);
    syncButtons(visibleImages());
  });

  // 切换标签页时自动同步扫描，像 Fatkun 侧栏一样边逛边看
  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(() => {
      void scanCurrentTab(false);
    });
  }

  void scanCurrentTab(false);
})();
