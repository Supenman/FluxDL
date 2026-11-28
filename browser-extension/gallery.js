(function () {
  "use strict";

  const summaryText = document.getElementById("summary-text");
  const renameTpl = document.getElementById("rename-tpl");
  const btnCopy = document.getElementById("btn-copy");
  const btnStitch = document.getElementById("btn-stitch");
  const btnDownload = document.getElementById("btn-download");

  const fQuery = document.getElementById("f-query");
  const fSource = document.getElementById("f-source");
  const fMinW = document.getElementById("f-min-w");
  const fMinH = document.getElementById("f-min-h");
  const fExt = document.getElementById("f-ext");
  const fSort = document.getElementById("f-sort");
  const fHdOnly = document.getElementById("f-hd-only");

  const btnSelectAll = document.getElementById("btn-select-all");
  const btnInvert = document.getElementById("btn-invert");
  const btnClearSel = document.getElementById("btn-clear-sel");

  const grid = document.getElementById("grid");
  const toastEl = document.getElementById("toast");

  const lightbox = document.getElementById("lightbox");
  const lbTitle = document.getElementById("lb-title");
  const lbImg = document.getElementById("lb-img");
  const lbOpen = document.getElementById("lb-open");
  const lbSend = document.getElementById("lb-send");
  const lbClose = document.getElementById("lb-close");

  let allImages = [];
  let sources = [];
  let selected = new Set();
  let currentLbItem = null;
  let toastTimer = null;

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2400);
  }

  function inferExt(item) {
    const m = String(item.url || item.filename || "").match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    if (!m) return "jpg";
    const e = m[1].toLowerCase();
    return e === "jpeg" ? "jpg" : e;
  }

  function sanitizeName(str) {
    return String(str || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  }

  function buildFilename(item, idx) {
    const mode = renameTpl.value;
    const ext = inferExt(item);
    const seq = String(idx + 1).padStart(3, "0");
    if (mode === "index") return `${seq}.${ext}`;
    if (mode === "title_index") {
      const prefix = sanitizeName(item.tabTitle || "image") || "image";
      return `${prefix}_${seq}.${ext}`;
    }
    return item.filename || `image_${seq}.${ext}`;
  }

  function filteredImages() {
    const q = fQuery.value.trim().toLowerCase();
    const src = fSource.value;
    const minW = Number(fMinW.value) || 0;
    const minH = Number(fMinH.value) || 0;
    const ext = fExt.value;
    const hdOnly = fHdOnly.checked;

    const list = allImages.filter((item) => {
      if (src !== "all" && String(item.tabId) !== src) return false;
      if (hdOnly && !item.upgraded) return false;
      if (ext !== "all" && inferExt(item) !== ext) return false;
      const w = item.width || 0;
      const h = item.height || 0;
      if (minW > 0 && w > 0 && w < minW) return false;
      if (minH > 0 && h > 0 && h < minH) return false;
      if (q) {
        const hay = `${item.filename || ""} ${item.url || ""} ${item.tabTitle || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const sortKey = fSort.value;
    list.sort((a, b) => {
      if (sortKey === "width") return (b.width || 0) - (a.width || 0);
      if (sortKey === "name") return String(a.filename || "").localeCompare(String(b.filename || ""));
      return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
    });
    return list;
  }

  function syncToolbar(visible) {
    const visSet = new Set(visible.map((i) => i.url));
    for (const u of Array.from(selected)) {
      if (!visSet.has(u)) selected.delete(u);
    }
    const n = selected.size;
    btnDownload.disabled = n === 0;
    btnCopy.disabled = n === 0;
    btnStitch.disabled = n < 2;
    btnDownload.textContent = `发送到 FluxDL (${n})`;
    const hdCount = visible.filter((i) => i.upgraded).length;
    summaryText.textContent = `来自 ${Math.max(1, sources.length)} 个页面 · 当前显示 ${visible.length} / ${allImages.length} 张（含 ${hdCount} 张已还原 HD 原图）`;
  }

  function openLightbox(item) {
    currentLbItem = item;
    lbTitle.textContent = `${item.filename}  (${item.width || "?"}×${item.height || "?"})${item.upgraded ? ` · 原图规则：${item.rule}` : ""}`;
    lbImg.src = item.url;
    lbOpen.href = item.url;
    lightbox.hidden = false;
  }

  function closeLightbox() {
    lightbox.hidden = true;
    lbImg.src = "";
    currentLbItem = null;
  }

  function render() {
    const list = filteredImages();
    syncToolbar(list);
    grid.textContent = "";

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "没有符合筛选条件的图片，可调低最小宽高或切换来源页。";
      grid.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of list) {
      const card = document.createElement("div");
      card.className = "card" + (selected.has(item.url) ? " is-selected" : "");

      const thumb = document.createElement("div");
      thumb.className = "thumb-wrap";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "card-check";
      cb.checked = selected.has(item.url);

      const img = document.createElement("img");
      img.src = item.previewUrl || item.url;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";

      const badges = document.createElement("div");
      badges.className = "card-badges";
      const extBadge = document.createElement("span");
      extBadge.className = "badge";
      extBadge.textContent = inferExt(item).toUpperCase();
      badges.appendChild(extBadge);
      if (item.upgraded) {
        const hd = document.createElement("span");
        hd.className = "badge hd";
        hd.textContent = "HD";
        hd.title = `已通过「${item.rule}」规则还原原图`;
        badges.appendChild(hd);
      }

      const zoomBtn = document.createElement("button");
      zoomBtn.type = "button";
      zoomBtn.className = "zoom-btn";
      zoomBtn.textContent = "看原图";
      zoomBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openLightbox(item);
      });

      thumb.appendChild(cb);
      thumb.appendChild(img);
      thumb.appendChild(badges);
      thumb.appendChild(zoomBtn);

      const foot = document.createElement("div");
      foot.className = "card-foot";
      const nameEl = document.createElement("div");
      nameEl.className = "card-name";
      nameEl.textContent = item.filename || "image";
      nameEl.title = item.url;
      const metaEl = document.createElement("div");
      metaEl.className = "card-meta";
      metaEl.innerHTML = `<span>${item.width && item.height ? `${item.width} × ${item.height}` : "尺寸未知"}</span><span>${item.upgraded ? item.rule : ""}</span>`;
      foot.appendChild(nameEl);
      foot.appendChild(metaEl);

      const toggle = () => {
        if (selected.has(item.url)) selected.delete(item.url);
        else selected.add(item.url);
        cb.checked = selected.has(item.url);
        card.classList.toggle("is-selected", cb.checked);
        syncToolbar(list);
      };

      card.addEventListener("click", toggle);
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        toggle();
      });

      card.appendChild(thumb);
      card.appendChild(foot);
      frag.appendChild(card);
    }
    grid.appendChild(frag);
  }

  async function sendBatch(items) {
    let ok = 0;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      try {
        const res = await chrome.runtime.sendMessage({
          type: "sendDownload",
          silent: true,
          payload: {
            url: item.url,
            kind: "http",
            filename: buildFilename(item, i),
            referer: item.referer,
          },
        });
        if (res && res.ok) ok += 1;
      } catch {
        // ignore single error
      }
    }
    return ok;
  }

  btnDownload.addEventListener("click", async () => {
    const picked = filteredImages().filter((i) => selected.has(i.url));
    if (picked.length === 0) return;
    btnDownload.disabled = true;
    btnDownload.textContent = `发送中 (0/${picked.length})…`;
    const ok = await sendBatch(picked);
    showToast(`已成功发送 ${ok} / ${picked.length} 张原图到 FluxDL 桌面端`);
    syncToolbar(filteredImages());
  });

  btnCopy.addEventListener("click", async () => {
    const urls = filteredImages()
      .filter((i) => selected.has(i.url))
      .map((i) => i.url);
    if (!urls.length) return;
    try {
      await navigator.clipboard.writeText(urls.join("\n"));
      showToast(`已复制 ${urls.length} 条原图直链`);
    } catch {
      showToast("复制失败，请检查剪贴板权限");
    }
  });

  // 纯原生 Canvas 纵向拼成长图导出 PNG（零外部依赖）
  btnStitch.addEventListener("click", async () => {
    const picked = filteredImages().filter((i) => selected.has(i.url)).slice(0, 30);
    if (picked.length < 2) return;
    btnStitch.disabled = true;
    btnStitch.textContent = "拼图中…";
    try {
      const loaded = [];
      for (const item of picked) {
        try {
          const resp = await fetch(item.url, { credentials: "omit", referrerPolicy: "no-referrer" });
          if (!resp.ok) continue;
          const blob = await resp.blob();
          const bmp = await createImageBitmap(blob);
          loaded.push(bmp);
        } catch {
          // 跨域或单张失败跳过
        }
      }
      if (loaded.length < 2) {
        showToast("可读取的图片不足 2 张（部分站点开启防盗链），建议直接发送到 FluxDL 下载");
        return;
      }
      const targetW = Math.min(1600, Math.max(...loaded.map((b) => b.width)));
      const heights = loaded.map((b) => Math.round((b.height * targetW) / b.width));
      const totalH = heights.reduce((a, b) => a + b, 0);
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = totalH;
      const ctx = canvas.getContext("2d");
      let y = 0;
      loaded.forEach((bmp, i) => {
        ctx.drawImage(bmp, 0, y, targetW, heights[i]);
        y += heights[i];
        bmp.close();
      });
      const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (outBlob) {
        const dlUrl = URL.createObjectURL(outBlob);
        const a = document.createElement("a");
        a.href = dlUrl;
        a.download = `fluxdl-stitch-${Date.now()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(dlUrl), 3000);
        showToast(`已拼合 ${loaded.length} 张图片并导出长图`);
      }
    } finally {
      btnStitch.textContent = "拼成长图";
      syncToolbar(filteredImages());
    }
  });

  btnSelectAll.addEventListener("click", () => {
    for (const item of filteredImages()) selected.add(item.url);
    render();
  });

  btnInvert.addEventListener("click", () => {
    for (const item of filteredImages()) {
      if (selected.has(item.url)) selected.delete(item.url);
      else selected.add(item.url);
    }
    render();
  });

  btnClearSel.addEventListener("click", () => {
    selected.clear();
    render();
  });

  for (const el of [fQuery, fSource, fMinW, fMinH, fExt, fSort, fHdOnly]) {
    el.addEventListener("input", render);
    el.addEventListener("change", render);
  }

  lbClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.hidden) closeLightbox();
  });
  lbSend.addEventListener("click", async () => {
    if (!currentLbItem) return;
    const ok = await sendBatch([currentLbItem]);
    showToast(ok ? "已发送原图到 FluxDL" : "发送失败，请确认 FluxDL 桌面端已启动");
  });

  async function boot() {
    const resp = await chrome.runtime.sendMessage({ type: "getGallerySession" });
    const session = resp && resp.session;
    if (!session || !Array.isArray(session.images)) {
      summaryText.textContent = "暂无采集数据，请从 FluxDL 扩展弹窗点击「抓取当前页 / 所有标签页」进入。";
      render();
      return;
    }
    allImages = session.images;
    sources = Array.isArray(session.sources) ? session.sources : [];
    for (const s of sources) {
      const opt = document.createElement("option");
      opt.value = String(s.tabId);
      opt.textContent = `${s.title.slice(0, 28)} (${s.count})`;
      fSource.appendChild(opt);
    }
    // 默认勾选符合初始最小尺寸的图
    for (const item of filteredImages()) selected.add(item.url);
    render();
  }

  void boot();
})();
