(function () {
  "use strict";

  const summaryText = document.getElementById("summary-text");
  const renameTpl = document.getElementById("rename-tpl");
  const exportFmt = document.getElementById("export-fmt");
  const btnExportTxt = document.getElementById("btn-export-txt");
  const btnStitch = document.getElementById("btn-stitch");
  const btnZip = document.getElementById("btn-zip");
  const btnDownload = document.getElementById("btn-download");

  const fQuery = document.getElementById("f-query");
  const fSource = document.getElementById("f-source");
  const fMinW = document.getElementById("f-min-w");
  const fMaxW = document.getElementById("f-max-w");
  const fMinH = document.getElementById("f-min-h");
  const fMaxH = document.getElementById("f-max-h");
  const fRatio = document.getElementById("f-ratio");
  const fExt = document.getElementById("f-ext");
  const fGroup = document.getElementById("f-group");
  const fSort = document.getElementById("f-sort");
  const fHdOnly = document.getElementById("f-hd-only");
  const fHideBroken = document.getElementById("f-hide-broken");
  const fZoom = document.getElementById("f-zoom");

  const btnSelectAll = document.getElementById("btn-select-all");
  const btnInvert = document.getElementById("btn-invert");
  const btnClearSel = document.getElementById("btn-clear-sel");

  const grid = document.getElementById("grid");
  const toastEl = document.getElementById("toast");

  const lightbox = document.getElementById("lightbox");
  const lbTitle = document.getElementById("lb-title");
  const lbImg = document.getElementById("lb-img");
  const lbPrev = document.getElementById("lb-prev");
  const lbNext = document.getElementById("lb-next");
  const lbOpen = document.getElementById("lb-open");
  const lbSend = document.getElementById("lb-send");
  const lbClose = document.getElementById("lb-close");

  let allImages = [];
  let sources = [];
  let selected = new Set();
  let lastClickedUrl = null;
  let currentVisible = [];
  let currentLbIndex = -1;
  let toastTimer = null;
  let backfillTimer = null;

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2600);
  }

  function inferExt(item) {
    const url = String(item.url || "");
    if (url.startsWith("data:image/")) {
      const dm = url.match(/^data:image\/([a-z0-9+.-]+);/i);
      if (dm) {
        const sub = dm[1].toLowerCase();
        if (sub === "jpeg") return "jpg";
        if (sub.includes("svg")) return "svg";
        return sub;
      }
    }
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

  function buildFilename(item, idx, forcedExt) {
    const mode = renameTpl ? renameTpl.value : "orig";
    const ext = forcedExt || inferExt(item);
    const seq = String(idx + 1).padStart(3, "0");
    if (mode === "index") return `${seq}.${ext}`;
    if (mode === "title_index") {
      const prefix = sanitizeName(item.tabTitle || "image") || "image";
      return `${prefix}_${seq}.${ext}`;
    }
    if (mode === "dim_index") {
      const dim = item.width && item.height ? `${item.width}x${item.height}` : "unknown";
      return `${dim}_${seq}.${ext}`;
    }
    const base = sanitizeName(item.filename || `image_${seq}.${ext}`) || `image_${seq}.${ext}`;
    if (forcedExt) {
      return base.replace(/\.[^.]+$/, "") + "." + forcedExt;
    }
    return base;
  }

  function parseOptionalNum(el) {
    if (!el) return null;
    const raw = String(el.value || "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function filteredImages() {
    const q = fQuery.value.trim().toLowerCase();
    const src = fSource.value;
    const minW = parseOptionalNum(fMinW);
    const maxW = parseOptionalNum(fMaxW);
    const minH = parseOptionalNum(fMinH);
    const maxH = parseOptionalNum(fMaxH);
    const ratio = fRatio ? fRatio.value : "all";
    const ext = fExt.value;
    const hdOnly = fHdOnly.checked;
    const hideBroken = fHideBroken ? fHideBroken.checked : true;

    const list = allImages.filter((item) => {
      if (hideBroken && item.broken) return false;
      if (src !== "all" && String(item.tabId) !== src) return false;
      if (hdOnly && !item.upgraded) return false;
      if (ext !== "all" && inferExt(item) !== ext) return false;

      const w = item.width || 0;
      const h = item.height || 0;
      if (minW !== null && minW > 0 && w > 0 && w < minW) return false;
      if (maxW !== null && w > 0 && w > maxW) return false;
      if (minH !== null && minH > 0 && h > 0 && h < minH) return false;
      if (maxH !== null && h > 0 && h > maxH) return false;

      if (ratio !== "all") {
        if (w <= 0 || h <= 0) return false;
        if (ratio === "landscape" && !(w > h * 1.1)) return false;
        if (ratio === "portrait" && !(h > w * 1.1)) return false;
        if (ratio === "square" && !(Math.abs(w - h) <= Math.max(w, h) * 0.1)) return false;
      }

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
    btnExportTxt.disabled = n === 0;
    btnZip.disabled = n === 0;
    btnStitch.disabled = n < 2;
    btnDownload.textContent = `发送到 FluxDL (${n})`;
    const hdCount = visible.filter((i) => i.upgraded).length;
    const brokenCount = allImages.filter((i) => i.broken).length;
    const brokenNote = brokenCount > 0 ? ` · 已过滤 ${brokenCount} 张破图` : "";
    summaryText.textContent = `来自 ${Math.max(1, sources.length)} 个页面 · 显示 ${visible.length} / ${allImages.length} 张（${hdCount} 张 HD 原图${brokenNote}）`;
  }

  function scheduleBackfillRefresh() {
    if (backfillTimer) clearTimeout(backfillTimer);
    backfillTimer = setTimeout(() => {
      backfillTimer = null;
      const list = filteredImages();
      syncToolbar(list);
      // 若开启隐藏破图且有新破图，或当前启用了尺寸/比例过滤导致条目应变化，则温和重绘
      const prevUrls = currentVisible.map((i) => i.url).join("\n");
      const nextUrls = list.map((i) => i.url).join("\n");
      if (prevUrls !== nextUrls) {
        render();
      }
    }, 320);
  }

  function openLightboxAt(index) {
    if (!currentVisible.length) return;
    const safeIdx = ((index % currentVisible.length) + currentVisible.length) % currentVisible.length;
    currentLbIndex = safeIdx;
    const item = currentVisible[safeIdx];
    const selMark = selected.has(item.url) ? " [已选]" : "";
    lbTitle.textContent = `[${safeIdx + 1}/${currentVisible.length}] ${item.filename} (${item.width || "?"}×${item.height || "?"})${item.upgraded ? ` · ${item.rule}` : ""}${selMark}`;
    lbImg.src = item.url;
    lbOpen.href = item.url;
    lightbox.hidden = false;
  }

  function closeLightbox() {
    lightbox.hidden = true;
    lbImg.src = "";
    currentLbIndex = -1;
  }

  function createCard(item, listIndex, listRef) {
    const card = document.createElement("div");
    card.className = "card" + (selected.has(item.url) ? " is-selected" : "") + (item.broken ? " is-broken" : "");

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
      openLightboxAt(listIndex);
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
    const dimSpan = document.createElement("span");
    dimSpan.textContent = item.width && item.height ? `${item.width} × ${item.height}` : "探测尺寸…";
    const ruleSpan = document.createElement("span");
    ruleSpan.textContent = item.upgraded ? item.rule : "";
    metaEl.appendChild(dimSpan);
    metaEl.appendChild(ruleSpan);
    foot.appendChild(nameEl);
    foot.appendChild(metaEl);

    // 真实分辨率回填 + 破图检测（对齐 Fatkun 核心体验）
    img.addEventListener("load", () => {
      const nw = img.naturalWidth || 0;
      const nh = img.naturalHeight || 0;
      if (nw > 0 && nh > 0) {
        if (!item.width || !item.height || nw > item.width || nh > item.height) {
          item.width = nw;
          item.height = nh;
          dimSpan.textContent = `${nw} × ${nh}`;
          scheduleBackfillRefresh();
        }
      }
    });
    img.addEventListener("error", () => {
      item.broken = true;
      card.classList.add("is-broken");
      dimSpan.textContent = "加载失败";
      scheduleBackfillRefresh();
    });

    const handleToggle = (shiftKey) => {
      if (shiftKey && lastClickedUrl) {
        const prevIdx = listRef.findIndex((x) => x.url === lastClickedUrl);
        if (prevIdx >= 0 && prevIdx !== listIndex) {
          const [start, end] = prevIdx < listIndex ? [prevIdx, listIndex] : [listIndex, prevIdx];
          const targetChecked = !selected.has(item.url);
          for (let k = start; k <= end; k += 1) {
            if (targetChecked) selected.add(listRef[k].url);
            else selected.delete(listRef[k].url);
          }
          lastClickedUrl = item.url;
          render();
          return;
        }
      }
      if (selected.has(item.url)) selected.delete(item.url);
      else selected.add(item.url);
      lastClickedUrl = item.url;
      cb.checked = selected.has(item.url);
      card.classList.toggle("is-selected", cb.checked);
      syncToolbar(listRef);
    };

    card.addEventListener("click", (e) => handleToggle(e.shiftKey));
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      handleToggle(e.shiftKey);
    });

    card.appendChild(thumb);
    card.appendChild(foot);
    return card;
  }

  function groupBucket(item, mode) {
    if (mode === "source") {
      return item.tabTitle || "当前页面";
    }
    const edge = Math.max(item.width || 0, item.height || 0);
    if (edge >= 1200) return "超大原图 (≥ 1200px)";
    if (edge >= 600) return "大图 (600–1199px)";
    if (edge >= 300) return "中图 (300–599px)";
    return "小图 / 待探测 (< 300px)";
  }

  function render() {
    const list = filteredImages();
    currentVisible = list;
    syncToolbar(list);
    grid.textContent = "";

    const groupMode = fGroup ? fGroup.value : "none";
    grid.classList.toggle("is-grouped", groupMode !== "none");

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "没有符合筛选条件的图片，可调低最小宽高或切换来源页。";
      grid.appendChild(empty);
      return;
    }

    if (groupMode === "none") {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < list.length; i += 1) {
        frag.appendChild(createCard(list[i], i, list));
      }
      grid.appendChild(frag);
      return;
    }

    // 分组视图：保持每张卡在 currentVisible 中的索引，Shift 连选与灯箱切换依然连贯
    const groups = new Map();
    const sizeOrder = [
      "超大原图 (≥ 1200px)",
      "大图 (600–1199px)",
      "中图 (300–599px)",
      "小图 / 待探测 (< 300px)",
    ];
    for (let i = 0; i < list.length; i += 1) {
      const key = groupBucket(list[i], groupMode);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ item: list[i], idx: i });
    }

    const keys = groupMode === "size"
      ? sizeOrder.filter((k) => groups.has(k))
      : Array.from(groups.keys());

    const frag = document.createDocumentFragment();
    for (const key of keys) {
      const entries = groups.get(key);
      const sec = document.createElement("section");
      sec.className = "group-section";

      const head = document.createElement("div");
      head.className = "group-head";
      const title = document.createElement("span");
      title.className = "group-title";
      title.textContent = `${key} · ${entries.length} 张`;

      const groupSelBtn = document.createElement("button");
      groupSelBtn.type = "button";
      groupSelBtn.className = "btn sm";
      const allGroupSel = entries.every((e) => selected.has(e.item.url));
      groupSelBtn.textContent = allGroupSel ? "取消本组" : "全选本组";
      groupSelBtn.addEventListener("click", () => {
        for (const e of entries) {
          if (allGroupSel) selected.delete(e.item.url);
          else selected.add(e.item.url);
        }
        render();
      });

      head.appendChild(title);
      head.appendChild(groupSelBtn);

      const gGrid = document.createElement("div");
      gGrid.className = "group-grid";
      for (const e of entries) {
        gGrid.appendChild(createCard(e.item, e.idx, list));
      }

      sec.appendChild(head);
      sec.appendChild(gGrid);
      frag.appendChild(sec);
    }
    grid.appendChild(frag);
  }

  /* ------------------------------------------------------------------ *
   * 纯原生零依赖 ZIP 打包器（Store 方法 0 + 标准 CRC32，兼容 Windows/macOS）
   * ------------------------------------------------------------------ */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function buildZipBlob(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.bytes;
      const crc = crc32(data);
      const size = data.length;

      // Local File Header (30 bytes + filename)
      const lh = new ArrayBuffer(30 + nameBytes.length);
      const lv = new DataView(lh);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
      lv.setUint16(8, 0, true);      // Store (no compression; images are already compressed)
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      new Uint8Array(lh, 30).set(nameBytes);
      localParts.push(new Uint8Array(lh), data);

      // Central Directory Header (46 bytes + filename)
      const ch = new ArrayBuffer(46 + nameBytes.length);
      const cv = new DataView(ch);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      new Uint8Array(ch, 46).set(nameBytes);
      centralParts.push(new Uint8Array(ch));

      offset += 30 + nameBytes.length + size;
    }

    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, new Uint8Array(eocd)], {
      type: "application/zip",
    });
  }

  function triggerBlobDownload(blob, filename) {
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = dlUrl;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(dlUrl), 4000);
  }

  async function convertBlobIfNeeded(blob, targetFmt) {
    if (targetFmt !== "jpg" && targetFmt !== "png") {
      return { blob, ext: null };
    }
    const bmp = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      if (targetFmt === "jpg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bmp, 0, 0);
      const mime = targetFmt === "jpg" ? "image/jpeg" : "image/png";
      const out = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.92));
      return out ? { blob: out, ext: targetFmt } : { blob, ext: null };
    } finally {
      bmp.close();
    }
  }

  async function sendBatch(items) {
    let ok = 0;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!/^https?:/i.test(item.url || "")) continue;
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
    const picked = currentVisible.filter((i) => selected.has(i.url));
    if (picked.length === 0) return;
    btnDownload.disabled = true;
    btnDownload.textContent = `发送中 (0/${picked.length})…`;
    const ok = await sendBatch(picked);
    showToast(`已成功发送 ${ok} / ${picked.length} 张原图到 FluxDL 桌面端`);
    syncToolbar(currentVisible);
  });

  btnExportTxt.addEventListener("click", async () => {
    const urls = currentVisible
      .filter((i) => selected.has(i.url))
      .map((i) => i.url);
    if (!urls.length) return;
    const text = urls.join("\n") + "\n";
    triggerBlobDownload(new Blob([text], { type: "text/plain;charset=utf-8" }), `fluxdl-links-${Date.now()}.txt`);
    try {
      await navigator.clipboard.writeText(urls.join("\n"));
      showToast(`已导出 ${urls.length} 条链接清单并同步复制到剪贴板`);
    } catch {
      showToast(`已导出 ${urls.length} 条链接清单 (.txt)`);
    }
  });

  btnZip.addEventListener("click", async () => {
    const picked = currentVisible.filter((i) => selected.has(i.url));
    if (!picked.length) return;
    const targetFmt = exportFmt ? exportFmt.value : "orig";
    btnZip.disabled = true;
    const usedNames = new Set();
    const files = [];
    let failed = 0;

    try {
      for (let i = 0; i < picked.length; i += 1) {
        btnZip.textContent = `打包中 (${i + 1}/${picked.length})`;
        const item = picked[i];
        try {
          const resp = await fetch(item.url, { credentials: "omit", referrerPolicy: "no-referrer" });
          if (!resp.ok) {
            failed += 1;
            continue;
          }
          const rawBlob = await resp.blob();
          const { blob, ext } = await convertBlobIfNeeded(rawBlob, targetFmt);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let fname = buildFilename(item, i, ext);
          if (usedNames.has(fname.toLowerCase())) {
            const dot = fname.lastIndexOf(".");
            fname = dot > 0
              ? `${fname.slice(0, dot)}_${i + 1}${fname.slice(dot)}`
              : `${fname}_${i + 1}`;
          }
          usedNames.add(fname.toLowerCase());
          files.push({ name: fname, bytes });
        } catch {
          failed += 1;
        }
      }
      if (!files.length) {
        showToast("所选图片均开启防盗链无法本地打包，请直接点击「发送到 FluxDL」下载");
        return;
      }
      const zipBlob = buildZipBlob(files);
      triggerBlobDownload(zipBlob, `fluxdl-images-${Date.now()}.zip`);
      showToast(
        failed > 0
          ? `已打包 ${files.length} 张为 ZIP（${failed} 张受跨域限制已跳过，可发往 FluxDL）`
          : `已成功打包 ${files.length} 张图片为 ZIP`,
      );
    } finally {
      btnZip.textContent = "打包 ZIP";
      syncToolbar(currentVisible);
    }
  });

  // 纯原生 Canvas 纵向拼成长图导出 PNG（零外部依赖）
  btnStitch.addEventListener("click", async () => {
    const picked = currentVisible.filter((i) => selected.has(i.url)).slice(0, 30);
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
        triggerBlobDownload(outBlob, `fluxdl-stitch-${Date.now()}.png`);
        showToast(`已拼合 ${loaded.length} 张图片并导出长图`);
      }
    } finally {
      btnStitch.textContent = "拼成长图";
      syncToolbar(currentVisible);
    }
  });

  btnSelectAll.addEventListener("click", () => {
    for (const item of currentVisible) selected.add(item.url);
    render();
  });

  btnInvert.addEventListener("click", () => {
    for (const item of currentVisible) {
      if (selected.has(item.url)) selected.delete(item.url);
      else selected.add(item.url);
    }
    render();
  });

  btnClearSel.addEventListener("click", () => {
    selected.clear();
    render();
  });

  for (const el of [fQuery, fSource, fMinW, fMaxW, fMinH, fMaxH, fRatio, fExt, fGroup, fSort, fHdOnly, fHideBroken]) {
    if (!el) continue;
    el.addEventListener("input", render);
    el.addEventListener("change", render);
  }

  if (fZoom) {
    fZoom.addEventListener("input", () => {
      document.documentElement.style.setProperty("--card-w", `${fZoom.value}px`);
    });
  }

  lbClose.addEventListener("click", closeLightbox);
  if (lbPrev) lbPrev.addEventListener("click", () => openLightboxAt(currentLbIndex - 1));
  if (lbNext) lbNext.addEventListener("click", () => openLightboxAt(currentLbIndex + 1));
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  window.addEventListener("keydown", (e) => {
    if (lightbox.hidden) return;
    if (e.key === "Escape") {
      closeLightbox();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      openLightboxAt(currentLbIndex - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      openLightboxAt(currentLbIndex + 1);
    } else if (e.key === " ") {
      e.preventDefault();
      const item = currentVisible[currentLbIndex];
      if (item) {
        if (selected.has(item.url)) selected.delete(item.url);
        else selected.add(item.url);
        render();
        openLightboxAt(currentLbIndex);
      }
    }
  });
  lbSend.addEventListener("click", async () => {
    const item = currentVisible[currentLbIndex];
    if (!item) return;
    const ok = await sendBatch([item]);
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
    for (const item of filteredImages()) selected.add(item.url);
    render();
  }

  void boot();
})();
