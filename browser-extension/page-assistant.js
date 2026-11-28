/**
 * FluxDL 深度页面助手（ISOLATED world，零凭证、零外连、不改写网页安全头）：
 * 1. 全量深度抓图：支持自动滚动触发懒加载，扫描 <img> / srcset / 10+ 懒加载属性 /
 *    <picture> / <a href="图片直链"> / getComputedStyle 背景图 / data:image / 大尺寸 <canvas>。
 * 2. 自动调用 hd-rules.js 还原 34+ 类站点高清原图，并记录区域类型（主图/正文/背景/链接）。
 * 3. 页面视频悬浮下载按钮：仅在顶层窗口、鼠标悬停于较大 <video> 上时显示轻巧胶囊。
 */
(function () {
  "use strict";

  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) {
    return;
  }
  // 仅在顶层文档运行，避免页面里大量隐藏广告/统计 iframe 抢先返回空结果覆盖主文档扫描
  if (window !== window.top) {
    return;
  }

  const LAZY_ATTRS = [
    "data-original",
    "data-src",
    "data-lazy-src",
    "data-actualsrc",
    "data-url",
    "data-hi-res-src",
    "data-large-src",
    "data-zoom-image",
    "data-old-hires",
    "data-ks-lazyload",
    "data-img",
    "original-src",
  ];

  const IMG_EXT_RE = /\.(?:jpe?g|png|webp|gif|bmp|avif|svg)(?:[?#]|$)/i;

  function toAbsUrl(raw, allowData = false) {
    if (!raw || typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s || s.startsWith("blob:") || s.startsWith("javascript:")) return null;
    if (s.startsWith("data:image/")) {
      return allowData && s.length <= 2 * 1024 * 1024 ? s : null;
    }
    try {
      const u = new URL(s, window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (u.username || u.password) return null;
      return u.toString();
    } catch {
      return null;
    }
  }

  function pickLargestFromSrcset(srcset) {
    if (!srcset || typeof srcset !== "string") return null;
    let bestUrl = null;
    let bestScore = -1;
    for (const part of srcset.split(",")) {
      const tokens = part.trim().split(/\s+/);
      if (!tokens[0]) continue;
      const descriptor = tokens[1] || "";
      let score = 0;
      if (/^\d+w$/i.test(descriptor)) score = parseInt(descriptor, 10);
      else if (/^\d+(?:\.\d+)?x$/i.test(descriptor)) score = parseFloat(descriptor) * 1000;
      if (score >= bestScore) {
        bestScore = score;
        bestUrl = tokens[0];
      }
    }
    return bestUrl;
  }

  function inferImageFilename(url, idx) {
    if (String(url).startsWith("data:image/")) {
      const m = url.match(/^data:image\/([a-z0-9+.-]+);/i);
      const ext = m ? m[1].replace("jpeg", "jpg").replace("svg+xml", "svg") : "png";
      return `embedded_${String(idx + 1).padStart(3, "0")}.${ext}`;
    }
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").filter(Boolean).pop() || "";
      const decoded = decodeURIComponent(last).replace(/[\\/:*?"<>|]+/g, "_");
      if (decoded && IMG_EXT_RE.test(decoded)) {
        return decoded.slice(0, 120);
      }
    } catch {
      // ignore
    }
    return `image_${String(idx + 1).padStart(3, "0")}.jpg`;
  }

  async function autoScrollForLazyLoad() {
    const startY = window.scrollY;
    const maxH = Math.min(document.documentElement.scrollHeight || 0, 24000);
    const step = Math.max(500, Math.round(window.innerHeight * 0.85));
    for (let y = 0; y <= maxH; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 160));
    }
    window.scrollTo(0, startY);
    await new Promise((r) => setTimeout(r, 120));
  }

  function scanPageImages() {
    const hd = globalThis.__FLUXDL_HD_RULES__;
    const upgrade = (u) =>
      hd && typeof hd.upgradeToHdUrl === "function"
        ? hd.upgradeToHdUrl(u)
        : { url: u, upgraded: false, rule: null };

    const seen = new Map();
    const record = (rawUrl, previewUrl, width, height, sourceType) => {
      const abs = toAbsUrl(rawUrl, true);
      if (!abs) return;
      const isData = abs.startsWith("data:");
      const up = isData ? { url: abs, upgraded: false, rule: null } : upgrade(abs);
      const key = up.url;
      const prev = seen.get(key);
      const w = Math.round(Number(width) || 0);
      const h = Math.round(Number(height) || 0);
      if (prev) {
        prev.width = Math.max(prev.width, w);
        prev.height = Math.max(prev.height, h);
        return;
      }
      seen.set(key, {
        url: up.url,
        previewUrl: toAbsUrl(previewUrl, true) || abs,
        width: w,
        height: h,
        upgraded: Boolean(up.upgraded),
        rule: up.rule || null,
        sourceType: sourceType || "img",
        referer: window.location.href,
      });
    };

    // 收集顶层文档及同源 iframe 文档
    const docs = [document];
    for (const ifr of document.querySelectorAll("iframe")) {
      try {
        if (ifr.contentDocument && ifr.contentDocument !== document) {
          docs.push(ifr.contentDocument);
        }
      } catch {
        // 跨域 iframe 忽略
      }
    }

    // 1. <img> 元素（含 srcset 与 12 种常见懒加载属性）
    for (const doc of docs)
    for (const img of doc.querySelectorAll("img")) {
      const rect = img.getBoundingClientRect();
      const w = img.naturalWidth || rect.width;
      const h = img.naturalHeight || rect.height;
      const preview = img.currentSrc || img.getAttribute("src") || "";
      const fromSrcset = pickLargestFromSrcset(img.getAttribute("srcset"));
      let best = fromSrcset || "";
      if (!best) {
        for (const attr of LAZY_ATTRS) {
          const v = img.getAttribute(attr);
          if (v) {
            best = v;
            break;
          }
        }
      }
      if (!best) best = preview;
      if (best) record(best, preview || best, w, h, "img");
    }

    // 2. <picture><source srcset>
    for (const srcEl of document.querySelectorAll("picture source[srcset]")) {
      const best = pickLargestFromSrcset(srcEl.getAttribute("srcset"));
      if (best) {
        const parentImg = srcEl.parentElement && srcEl.parentElement.querySelector("img");
        const w = parentImg ? parentImg.naturalWidth || 0 : 0;
        const h = parentImg ? parentImg.naturalHeight || 0 : 0;
        record(best, best, w, h, "picture");
      }
    }

    // 3. <a href="...jpg/png/webp/gif"> 直接指向大图原图的链接
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (!IMG_EXT_RE.test(href)) continue;
      const innerImg = a.querySelector("img");
      const preview = innerImg ? innerImg.currentSrc || innerImg.getAttribute("src") || href : href;
      const w = innerImg ? innerImg.naturalWidth || 0 : 0;
      const h = innerImg ? innerImg.naturalHeight || 0 : 0;
      record(href, preview, w, h, "link");
    }

    // 4. CSS background-image（扫描计算样式，上限 600 个可见大节点防卡顿）
    const candidates = document.querySelectorAll("div, section, article, figure, a, span, li, header");
    let scannedBg = 0;
    for (const el of candidates) {
      if (scannedBg >= 600) break;
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) continue;
      scannedBg += 1;
      const bg = window.getComputedStyle(el).backgroundImage;
      if (!bg || bg === "none" || !bg.includes("url(")) continue;
      const matches = bg.matchAll(/url\((['"]?)(https?:[^'")]+)\1\)/gi);
      for (const m of matches) {
        if (m[2]) record(m[2], m[2], rect.width, rect.height, "bg");
      }
    }

    const list = Array.from(seen.values())
      .map((item, idx) => ({
        ...item,
        filename: inferImageFilename(item.url, idx),
      }))
      .sort((a, b) => b.width * b.height - a.width * a.height);

    return list.slice(0, 800);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "toggleClickDownload") {
      setClickDownloadMode(message.enabled !== undefined ? Boolean(message.enabled) : !clickDlActive);
      sendResponse({ ok: true, active: clickDlActive });
      return false;
    }
    if (message && message.type === "getClickDownloadState") {
      sendResponse({ ok: true, active: clickDlActive, count: clickDlCount });
      return false;
    }
    if (message && message.type === "scanPageImages") {
      (async () => {
        try {
          if (message.autoScroll && window === window.top) {
            await autoScrollForLazyLoad();
          }
          sendResponse({ ok: true, images: scanPageImages(), pageUrl: window.location.href });
        } catch (err) {
          sendResponse({ ok: false, error: String(err), images: [] });
        }
      })();
      return true;
    }
    return false;
  });

  // ------------------------------------------------------------------ //
  // 页面视频悬浮下载按钮（仅顶层窗口，零侵入 Shadow DOM，支持开关控制）
  // ------------------------------------------------------------------ //
  let widgetEnabled = true;
  let activeVideo = null;
  let hideTimer = null;
  let hostEl = null;
  let btnEl = null;

  function loadWidgetSetting() {
    try {
      chrome.storage.sync.get({ videoWidget: true }, (res) => {
        widgetEnabled = res && res.videoWidget !== false;
        if (!widgetEnabled) hideWidget();
      });
    } catch {
      // ignore
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.videoWidget) {
        widgetEnabled = changes.videoWidget.newValue !== false;
        if (!widgetEnabled) hideWidget();
      }
    });
  } catch {
    // ignore
  }
  loadWidgetSetting();

  function ensureWidget() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.id = "fluxdl-video-widget-host";
    hostEl.style.cssText =
      "position:fixed;z-index:2147483646;display:none;pointer-events:auto;";
    const shadow = hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      button {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 28px;
        padding: 0 11px;
        border: 1px solid rgba(255,255,255,0.22);
        border-radius: 999px;
        background: rgba(18, 22, 32, 0.84);
        color: #fff;
        font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        cursor: pointer;
        backdrop-filter: blur(8px);
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        transition: background 0.14s ease, transform 0.12s ease;
      }
      button:hover { background: #2563eb; transform: translateY(-1px); }
      button.ok { background: #16a34a; }
    `;
    btnEl = document.createElement("button");
    btnEl.type = "button";
    btnEl.textContent = "↓ FluxDL 下载";
    btnEl.addEventListener("mouseenter", () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    });
    btnEl.addEventListener("mouseleave", scheduleHide);
    btnEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (!activeVideo) return;
      const directSrc = toAbsUrl(activeVideo.currentSrc || activeVideo.getAttribute("src") || "", false);
      btnEl.textContent = "正在发送…";
      chrome.runtime.sendMessage(
        {
          type: "downloadVideoFromWidget",
          directUrl: directSrc,
          pageUrl: window.location.href,
          title: document.title || "",
        },
        (resp) => {
          if (resp && resp.ok) {
            btnEl.classList.add("ok");
            btnEl.textContent = "✓ 已发往 FluxDL";
          } else {
            btnEl.textContent = resp && resp.error ? "发送失败" : "请先打开 FluxDL";
          }
          setTimeout(() => {
            if (btnEl) {
              btnEl.classList.remove("ok");
              btnEl.textContent = "↓ FluxDL 下载";
            }
          }, 1800);
        },
      );
    });
    shadow.appendChild(style);
    shadow.appendChild(btnEl);
    (document.documentElement || document.body).appendChild(hostEl);
  }

  function positionWidget(video) {
    if (!hostEl || !video) return;
    const rect = video.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 160 || rect.bottom < 0 || rect.top > window.innerHeight) {
      hideWidget();
      return;
    }
    const top = Math.max(8, Math.min(window.innerHeight - 40, rect.top + 10));
    const right = Math.max(8, window.innerWidth - rect.right + 12);
    hostEl.style.top = `${Math.round(top)}px`;
    hostEl.style.right = `${Math.round(right)}px`;
    hostEl.style.display = "block";
  }

  function hideWidget() {
    activeVideo = null;
    if (hostEl) hostEl.style.display = "none";
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideWidget, 900);
  }

  function findVideoUnder(target) {
    if (!target || !(target instanceof Element)) return null;
    if (target.tagName === "VIDEO") return target;
    const closest = target.closest && target.closest("video");
    if (closest) return closest;
    const videos = document.querySelectorAll("video");
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width >= 260 && r.height >= 160) {
        const container = v.parentElement;
        if (container && container.contains(target)) return v;
      }
    }
    return null;
  }

  document.addEventListener(
    "mouseover",
    (e) => {
      if (!widgetEnabled) return;
      const v = findVideoUnder(e.target);
      if (!v) return;
      const rect = v.getBoundingClientRect();
      if (rect.width < 260 || rect.height < 160) return;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      activeVideo = v;
      ensureWidget();
      positionWidget(v);
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      if (!activeVideo) return;
      const related = e.relatedTarget;
      if (related && hostEl && (related === hostEl || hostEl.contains(related))) return;
      if (related && activeVideo.parentElement && activeVideo.parentElement.contains(related)) return;
      scheduleHide();
    },
    true,
  );

  window.addEventListener(
    "scroll",
    () => {
      if (activeVideo && hostEl && hostEl.style.display !== "none") {
        positionWidget(activeVideo);
      }
    },
    { passive: true },
  );

  // ------------------------------------------------------------------ //
  // Fatkun 熟悉工作流 #1：拖拽图片快捷下载 & 收集篮（Shadow DOM 零污染）
  // ------------------------------------------------------------------ //
  let dragDropEnabled = true;
  let draggedItem = null;
  let dragHost = null;
  let dragZoneDl = null;
  let dragZoneCol = null;
  let basketPillHost = null;
  let basketBtn = null;
  const collectedBasket = [];

  try {
    chrome.storage.sync.get({ dragDropImage: true }, (res) => {
      dragDropEnabled = res && res.dragDropImage !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.dragDropImage) {
        dragDropEnabled = changes.dragDropImage.newValue !== false;
      }
    });
  } catch {
    // ignore
  }

  function extractImageInfoFromEl(el) {
    if (!el || !(el instanceof Element)) return null;
    const img = el.tagName === "IMG" ? el : (el.querySelector && el.querySelector("img"));
    if (!img) return null;
    const preview = img.currentSrc || img.getAttribute("src") || "";
    const fromSrcset = pickLargestFromSrcset(img.getAttribute("srcset"));
    let raw = fromSrcset || "";
    if (!raw) {
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (v) { raw = v; break; }
      }
    }
    if (!raw) raw = preview;
    const abs = toAbsUrl(raw, false);
    if (!abs) return null;
    const hd = globalThis.__FLUXDL_HD_RULES__;
    const up = hd && typeof hd.upgradeToHdUrl === "function"
      ? hd.upgradeToHdUrl(abs)
      : { url: abs, upgraded: false, rule: null };
    const rect = img.getBoundingClientRect();
    return {
      url: up.url,
      previewUrl: toAbsUrl(preview, false) || abs,
      width: Math.round(img.naturalWidth || rect.width || 0),
      height: Math.round(img.naturalHeight || rect.height || 0),
      upgraded: Boolean(up.upgraded),
      rule: up.rule || null,
      filename: inferImageFilename(up.url, collectedBasket.length),
      referer: window.location.href,
    };
  }

  function showPageToast(text, ok = true) {
    const t = document.createElement("div");
    t.textContent = text;
    t.style.cssText = [
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;",
      "padding:8px 16px;border-radius:999px;font:600 12.5px/1.3 system-ui,-apple-system,sans-serif;",
      "color:#fff;box-shadow:0 8px 24px rgba(0,0,0,0.35);pointer-events:none;",
      `background:${ok ? "rgba(22,163,74,0.92)" : "rgba(220,38,38,0.92)"};`,
    ].join("");
    (document.documentElement || document.body).appendChild(t);
    setTimeout(() => t.remove(), 1900);
  }

  function updateBasketPill() {
    if (collectedBasket.length === 0) {
      if (basketPillHost) basketPillHost.style.display = "none";
      return;
    }
    if (!basketPillHost) {
      basketPillHost = document.createElement("div");
      basketPillHost.id = "fluxdl-basket-pill-host";
      basketPillHost.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483646;";
      const shadow = basketPillHost.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        .pill { display:flex; align-items:center; gap:6px; padding:6px 12px; border-radius:999px;
          background:rgba(15,23,42,0.9); color:#fff; border:1px solid rgba(59,130,246,0.6);
          font:600 12px/1 system-ui,-apple-system,sans-serif; box-shadow:0 6px 20px rgba(0,0,0,0.35); cursor:pointer; }
        .pill:hover { background:#2563eb; }
        .x { margin-left:4px; opacity:0.75; cursor:pointer; font-weight:700; }
        .x:hover { opacity:1; }
      `;
      basketBtn = document.createElement("div");
      basketBtn.className = "pill";
      basketBtn.addEventListener("click", (e) => {
        if (e.target && e.target.classList && e.target.classList.contains("x")) {
          collectedBasket.length = 0;
          updateBasketPill();
          return;
        }
        chrome.runtime.sendMessage({
          type: "openCollectedGallery",
          images: collectedBasket.slice(),
          pageTitle: document.title || "",
          pageUrl: window.location.href,
        });
      });
      shadow.appendChild(style);
      shadow.appendChild(basketBtn);
      (document.documentElement || document.body).appendChild(basketPillHost);
    }
    basketBtn.innerHTML = `<span>打开收集篮 (${collectedBasket.length} 张)</span><span class="x" title="清空收集篮">✕</span>`;
    basketPillHost.style.display = "block";
  }

  function ensureDragDock() {
    if (dragHost) return;
    dragHost = document.createElement("div");
    dragHost.id = "fluxdl-drag-dock-host";
    dragHost.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:none;";
    const shadow = dragHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .dock { display:flex; gap:12px; padding:10px 14px; border-radius:14px;
        background:rgba(15,17,23,0.92); border:1px solid rgba(255,255,255,0.18);
        backdrop-filter:blur(10px); box-shadow:0 12px 32px rgba(0,0,0,0.45);
        font:600 13px/1.3 system-ui,-apple-system,sans-serif; color:#eef1f6; }
      .zone { min-width:154px; padding:12px 16px; border-radius:10px; text-align:center;
        border:2px dashed rgba(255,255,255,0.28); background:rgba(255,255,255,0.04); transition:all 0.12s ease; }
      .zone.over { border-color:#3b82f6; background:rgba(59,130,246,0.24); transform:scale(1.03); }
      .zone small { display:block; margin-top:3px; font-weight:400; font-size:11px; color:#9aa3b2; }
    `;
    const dock = document.createElement("div");
    dock.className = "dock";
    dragZoneDl = document.createElement("div");
    dragZoneDl.className = "zone";
    dragZoneDl.innerHTML = "↓ 拖到这里下载原图<small>自动还原 HD 并发往 FluxDL</small>";
    dragZoneCol = document.createElement("div");
    dragZoneCol.className = "zone";
    dragZoneCol.innerHTML = "+ 加入待选收集篮<small>攒多张一起进画廊批量处理</small>";

    const bindZone = (zone, onDropAction) => {
      zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("over"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("over");
        if (dragHost) dragHost.style.display = "none";
        if (draggedItem) onDropAction(draggedItem);
        draggedItem = null;
      });
    };

    bindZone(dragZoneDl, (item) => {
      chrome.runtime.sendMessage(
        {
          type: "sendDownload",
          silent: true,
          payload: { url: item.url, kind: "http", filename: item.filename, referer: item.referer },
        },
        (resp) => {
          showPageToast(resp && resp.ok ? "✓ 已发送原图到 FluxDL" : "发送失败，请先启动 FluxDL", Boolean(resp && resp.ok));
        },
      );
    });
    bindZone(dragZoneCol, (item) => {
      if (!collectedBasket.some((x) => x.url === item.url)) {
        collectedBasket.push(item);
      }
      updateBasketPill();
      showPageToast(`✓ 已加入收集篮（共 ${collectedBasket.length} 张）`);
    });

    dock.appendChild(dragZoneDl);
    dock.appendChild(dragZoneCol);
    shadow.appendChild(style);
    shadow.appendChild(dock);
    (document.documentElement || document.body).appendChild(dragHost);
  }

  document.addEventListener(
    "dragstart",
    (e) => {
      if (!dragDropEnabled) return;
      const item = extractImageInfoFromEl(e.target);
      if (!item) return;
      draggedItem = item;
      ensureDragDock();
      dragHost.style.display = "block";
    },
    true,
  );

  document.addEventListener(
    "dragend",
    () => {
      if (dragHost) dragHost.style.display = "none";
      draggedItem = null;
    },
    true,
  );

  // ------------------------------------------------------------------ //
  // Fatkun 熟悉工作流 #2：点图即下载模式（连续点击图片直接发往 FluxDL）
  // ------------------------------------------------------------------ //
  let clickDlActive = false;
  let clickDlPaused = false;
  let clickDlCount = 0;
  let clickBarHost = null;
  let clickBarStatus = null;
  let clickBarPause = null;

  function updateClickBar() {
    if (!clickDlActive) {
      if (clickBarHost) clickBarHost.style.display = "none";
      return;
    }
    if (!clickBarHost) {
      clickBarHost = document.createElement("div");
      clickBarHost.id = "fluxdl-clickdl-bar-host";
      clickBarHost.style.cssText = "position:fixed;top:16px;right:18px;z-index:2147483647;";
      const shadow = clickBarHost.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        .bar { display:flex; align-items:center; gap:8px; padding:8px 12px; border-radius:999px;
          background:rgba(15,17,23,0.92); color:#fff; border:1px solid rgba(59,130,246,0.7);
          font:600 12px/1 system-ui,-apple-system,sans-serif; box-shadow:0 8px 24px rgba(0,0,0,0.4); }
        button { border:1px solid rgba(255,255,255,0.22); background:rgba(255,255,255,0.08);
          color:#fff; border-radius:999px; padding:4px 9px; font-size:11px; cursor:pointer; }
        button:hover { background:#2563eb; border-color:#2563eb; }
      `;
      const bar = document.createElement("div");
      bar.className = "bar";
      clickBarStatus = document.createElement("span");
      clickBarPause = document.createElement("button");
      clickBarPause.type = "button";
      clickBarPause.addEventListener("click", () => {
        clickDlPaused = !clickDlPaused;
        updateClickBar();
      });
      const exitBtn = document.createElement("button");
      exitBtn.type = "button";
      exitBtn.textContent = "退出";
      exitBtn.addEventListener("click", () => setClickDownloadMode(false));
      bar.appendChild(clickBarStatus);
      bar.appendChild(clickBarPause);
      bar.appendChild(exitBtn);
      shadow.appendChild(style);
      shadow.appendChild(bar);
      (document.documentElement || document.body).appendChild(clickBarHost);
    }
    clickBarStatus.textContent = clickDlPaused
      ? `点图下载已暂停 · 已发 ${clickDlCount} 张`
      : `点图即下载中（点击任意图片）· 已发 ${clickDlCount} 张`;
    clickBarPause.textContent = clickDlPaused ? "恢复" : "暂停";
    clickBarHost.style.display = "block";
  }

  function setClickDownloadMode(enabled) {
    clickDlActive = Boolean(enabled);
    clickDlPaused = false;
    updateClickBar();
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!clickDlActive || clickDlPaused) return;
      if (clickBarHost && (e.target === clickBarHost || clickBarHost.contains(e.target))) return;
      const item = extractImageInfoFromEl(e.target);
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      const targetImg = e.target.tagName === "IMG" ? e.target : e.target.querySelector("img");
      if (targetImg) {
        const prevOutline = targetImg.style.outline;
        targetImg.style.outline = "3px solid #22c55e";
        setTimeout(() => { targetImg.style.outline = prevOutline; }, 700);
      }
      chrome.runtime.sendMessage(
        {
          type: "sendDownload",
          silent: true,
          payload: { url: item.url, kind: "http", filename: item.filename, referer: item.referer },
        },
        (resp) => {
          if (resp && resp.ok) {
            clickDlCount += 1;
            updateClickBar();
          } else {
            showPageToast("发送失败，请先启动 FluxDL", false);
          }
        },
      );
    },
    true,
  );
})();
