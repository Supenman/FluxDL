/**
 * FluxDL 页面助手（ISOLATED world，零凭证、零外连、不改写网页安全头）：
 * 1. 按需页面批量抓图：响应弹窗请求，扫描 <img> / srcset / 懒加载属性 / 大尺寸背景图，
 *    自动调用 hd-rules.js 还原高清原图直链并去重。
 * 2. 页面视频悬浮下载按钮：仅在顶层窗口、鼠标悬停于较大 <video> 上时显示轻巧胶囊，
 *    点击一键发送到 FluxDL 桌面端，可在扩展弹窗随时关闭。
 */
(function () {
  "use strict";

  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) {
    return;
  }

  const LAZY_ATTRS = [
    "data-original",
    "data-src",
    "data-lazy-src",
    "data-actualsrc",
    "data-url",
    "data-hi-res-src",
  ];

  function toAbsHttpUrl(raw) {
    if (!raw || typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s || s.startsWith("data:") || s.startsWith("blob:") || s.startsWith("javascript:")) {
      return null;
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
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").filter(Boolean).pop() || "";
      const decoded = decodeURIComponent(last).replace(/[\\/:*?"<>|]+/g, "_");
      if (decoded && /\.(?:jpe?g|png|webp|gif|bmp|avif|svg)$/i.test(decoded)) {
        return decoded.slice(0, 120);
      }
    } catch {
      // ignore
    }
    return `image_${String(idx + 1).padStart(3, "0")}.jpg`;
  }

  function scanPageImages() {
    const hd = globalThis.__FLUXDL_HD_RULES__;
    const upgrade = (u) => (hd && typeof hd.upgradeToHdUrl === "function"
      ? hd.upgradeToHdUrl(u)
      : { url: u, upgraded: false, rule: null });

    const seen = new Map();
    const record = (rawUrl, previewUrl, width, height) => {
      const abs = toAbsHttpUrl(rawUrl);
      if (!abs) return;
      const up = upgrade(abs);
      const key = up.url;
      const prev = seen.get(key);
      const w = Number(width) || 0;
      const h = Number(height) || 0;
      if (prev) {
        prev.width = Math.max(prev.width, w);
        prev.height = Math.max(prev.height, h);
        return;
      }
      seen.set(key, {
        url: up.url,
        previewUrl: toAbsHttpUrl(previewUrl) || abs,
        width: w,
        height: h,
        upgraded: Boolean(up.upgraded),
        rule: up.rule || null,
        referer: window.location.href,
      });
    };

    // 1. <img> 元素（含 srcset 与常见懒加载属性）
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      const w = img.naturalWidth || Math.round(img.getBoundingClientRect().width);
      const h = img.naturalHeight || Math.round(img.getBoundingClientRect().height);
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
      if (best) record(best, preview || best, w, h);
    }

    // 2. <picture><source srcset>
    const sources = document.querySelectorAll("picture source[srcset]");
    for (const srcEl of sources) {
      const best = pickLargestFromSrcset(srcEl.getAttribute("srcset"));
      if (best) {
        const parentImg = srcEl.parentElement && srcEl.parentElement.querySelector("img");
        const w = parentImg ? parentImg.naturalWidth || 0 : 0;
        const h = parentImg ? parentImg.naturalHeight || 0 : 0;
        record(best, best, w, h);
      }
    }

    // 3. 大尺寸 CSS background-image（上限 120 个节点防重排卡顿）
    const bgNodes = document.querySelectorAll("[style*='background']");
    let checked = 0;
    for (const el of bgNodes) {
      if (checked >= 120) break;
      checked += 1;
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 120) continue;
      const bg = el.style.backgroundImage || "";
      const match = bg.match(/url\((['"]?)(https?:[^'")]+)\1\)/i);
      if (match && match[2]) {
        record(match[2], match[2], Math.round(rect.width), Math.round(rect.height));
      }
    }

    const list = Array.from(seen.values())
      .map((item, idx) => ({
        ...item,
        filename: inferImageFilename(item.url, idx),
      }))
      .sort((a, b) => b.width * b.height - a.width * a.height);

    return list.slice(0, 300);
  }

  // 响应弹窗「扫描本页图片」请求
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "scanPageImages") {
      try {
        sendResponse({ ok: true, images: scanPageImages(), pageUrl: window.location.href });
      } catch (err) {
        sendResponse({ ok: false, error: String(err), images: [] });
      }
      return true;
    }
    return false;
  });

  // ------------------------------------------------------------------ //
  // 页面视频悬浮下载按钮（仅顶层窗口，零侵入 Shadow DOM，支持开关控制）
  // ------------------------------------------------------------------ //
  if (window !== window.top) return;

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
      const directSrc = toAbsHttpUrl(activeVideo.currentSrc || activeVideo.getAttribute("src") || "");
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
            btnEl.textContent = (resp && resp.error) ? "发送失败" : "请先打开 FluxDL";
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
    // 很多播放器在 <video> 上面盖了一层透明控制 div，按鼠标坐标命中同容器内的 <video>
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
})();
