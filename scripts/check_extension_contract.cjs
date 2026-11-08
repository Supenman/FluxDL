/**
 * 浏览器扩展 ↔ 桌面端契约检查（v0.3.4）。
 *
 * 用 Node 直接跑，不依赖浏览器、不依赖外网：
 *   1. require(background.js) 不抛 ReferenceError（0.3.3 曾导出三个已删除符号）；
 *   2. 实际触发「发送到 FluxDL」消息，拦截 fetch，验证 payload 用 camelCase
 *      `userAgent`（0.3.3 的 `user_agent` 被 serde 静默丢弃 → 防盗链站点 403）；
 *   3. 前端 MEDIA_HOSTS 与 Rust looks_like_media HOSTS 必须逐项一致
 *      （0.3.3 两份名单分裂，同一链接两条入口会建成不同任务类型）。
 *
 * 用法：node scripts/check_extension_contract.cjs
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "browser-extension", "background.js");
const FORMAT_TS = path.join(ROOT, "src", "lib", "format.ts");
const TAURI_LIB = path.join(ROOT, "src-tauri", "src", "lib.rs");

// ---- 1. 用最小 stub 把 MV3 service worker 装进 Node ----
// 注意：仓库根 package.json 带 "type": "module"，直接 require(.js) 会走
// require(esm)，此时 `module` 未定义、module.exports 分支不会执行、拿不到导出。
// 因此这里用 new Function 以经典脚本语义执行，并把三个全局当参数注入。
const listeners = {};
// 0.3.6：getPageResources 的实跑需要可控的 tabs / session 数据，
// 这两个变量在 stub 的 getter 里「调用时」读取，测试可在加载后改写。
let pageQueryResult = [];
let pageSessionData = {};
function stub(name) {
  const fn = function () {};
  return new Proxy(fn, {
    get(_target, prop) {
      const key = String(prop);
      if (key === "then") return undefined; // 别被 await 当成 thenable
      if (key === "addListener") {
        return (cb) => {
          (listeners[name] ||= []).push(cb);
        };
      }
      if (key === "removeListener") return () => {};
      if (key === "get") return async () => pageSessionData;
      if (key === "set" || key === "remove" || key === "clear") return async () => {};
      if (key === "query") return async () => pageQueryResult;
      if (key === "getURL") return (p) => `chrome-extension://fluxdl-test/${p}`;
      return stub(`${name}.${key}`);
    },
    apply() {
      return undefined;
    },
  });
}

const chromeStub = new Proxy({}, { get: (_t, p) => stub(String(p)) });
const navigatorStub = { userAgent: "Mozilla/5.0 (FluxDL-Contract-Test)" };

const sent = [];
const fetchStub = async (url, init) => {
  sent.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ ok: true, id: "task-1" }) };
};

/** 以经典脚本语义加载扩展源码，拿到它挂在 module.exports 上的纯函数。 */
function loadExtension() {
  const src = fs.readFileSync(EXT, "utf8");
  const moduleObj = { exports: {} };
  const run = new Function("module", "exports", "chrome", "navigator", "fetch", src);
  run(moduleObj, moduleObj.exports, chromeStub, navigatorStub, fetchStub);
  return moduleObj.exports;
}

async function main() {
  // ---- 2. 加载本身即是回归点：导出已删除符号会直接 ReferenceError ----
  const mod = loadExtension();
  for (const dead of ["needsCookies", "netscapeCookies", "COOKIE_DOMAINS"]) {
    assert(!(dead in mod), `module.exports 仍导出已删除符号：${dead}`);
  }
  for (const needed of ["classify", "shouldCapture", "isVideoPage", "suggestedFilename"]) {
    assert.equal(typeof mod[needed], "function", `缺少导出：${needed}`);
  }

  // ---- 3. 实跑 payload 契约 ----
  const messageListeners = Object.entries(listeners)
    .filter(([key]) => key.endsWith("onMessage"))
    .flatMap(([, value]) => value);
  assert(messageListeners.length > 0, "未捕获 chrome.runtime.onMessage 监听器");

  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("onMessage 未回调 sendResponse")), 3000);
    messageListeners[0](
      {
        type: "sendDownload",
        payload: {
          url: "https://www.bilibili.com/video/BV1GysQ6hEgB",
          referer: "https://example.com/",
          filename: "demo.mp4",
        },
        silent: true,
      },
      {},
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
    );
  });

  assert(response && response.ok, `发送失败：${JSON.stringify(response)}`);
  assert.equal(sent.length, 1, "应只发一次 /api/downloads");
  assert(sent[0].url.endsWith("/api/downloads"), `错误的接口：${sent[0].url}`);
  assert.equal(sent[0].init.headers["x-fluxdl-token"], "fluxdl-local-v1");

  const body = JSON.parse(sent[0].init.body);
  assert.equal(
    body.userAgent,
    "Mozilla/5.0 (FluxDL-Contract-Test)",
    "扩展必须发送 camelCase userAgent，否则 Rust 侧读到 None",
  );
  assert(
    !Object.prototype.hasOwnProperty.call(body, "user_agent"),
    "扩展不得再发送 snake_case user_agent",
  );
  assert.equal(body.url, "https://www.bilibili.com/video/BV1GysQ6hEgB");
  assert.equal(body.referer, "https://example.com/");

  // 源码级兜底：防止有人改回自动接管里手写 user_agent
  const extSrc = fs.readFileSync(EXT, "utf8");
  assert(/userAgent:\s*navigator\.userAgent/.test(extSrc), "sendToFluxDL 必须统一注入 userAgent");
  assert(!/user_agent\s*:/.test(extSrc), "源码中不应再有 user_agent: 字段");

  // ---- 4. 前后端站点名单一致性 ----
  const tsSrc = fs.readFileSync(FORMAT_TS, "utf8");
  const rsSrc = fs.readFileSync(TAURI_LIB, "utf8");

  const tsMatch = tsSrc.match(/const MEDIA_HOSTS = \[([\s\S]*?)\]\s*as const/);
  assert(tsMatch, "前端未找到 MEDIA_HOSTS");
  const tsHosts = [...tsMatch[1].matchAll(/"([a-z0-9.-]+)"/gi)].map((m) => m[1].toLowerCase());

  const rsStart = rsSrc.indexOf("fn looks_like_media");
  assert(rsStart >= 0, "Rust 未找到 looks_like_media");
  const rsMatch = rsSrc
    .slice(rsStart)
    .match(/const HOSTS: &\[&str\] = &\[([\s\S]*?)\];/);
  assert(rsMatch, "Rust 未找到 HOSTS 数组");
  const rsHosts = [...rsMatch[1].matchAll(/"([a-z0-9.-]+)"/gi)].map((m) => m[1].toLowerCase());

  const tsSet = new Set(tsHosts);
  const rsSet = new Set(rsHosts);
  const onlyTs = [...tsSet].filter((h) => !rsSet.has(h));
  const onlyRs = [...rsSet].filter((h) => !tsSet.has(h));
  assert(
    onlyTs.length === 0 && onlyRs.length === 0,
    `站点名单分裂：前端独有 [${onlyTs}]，Rust 独有 [${onlyRs}]`,
  );
  assert(tsSet.size >= 25, `站点名单数量异常：${tsSet.size}`);

  // 前端必须按 hostname 判定，不能退回 includes
  assert(/new URL\(/.test(tsSrc) && /\.hostname/.test(tsSrc), "前端必须按 hostname 精确/后缀匹配");
  assert(
    /host === h \|\| host\.endsWith/.test(tsSrc),
    "前端必须使用精确 / 后缀匹配，不能用 includes",
  );

  // ---- 5. 0.3.5：CDN 容器直链短路 + 首页 / 发现页 / 快手不再当视频页 ----
  assert.equal(typeof mod.isDirectMediaFile, "function", "缺少导出：isDirectMediaFile");
  assert.equal(typeof mod.pageHint, "function", "缺少导出：pageHint");
  assert.equal(mod.isDirectMediaFile("https://v2.kuaishou.com/abc.mp4"), true);
  assert.equal(mod.isDirectMediaFile("https://cdn.douyin.com/x.mp4?token=a"), true);
  assert.equal(mod.isDirectMediaFile("https://cdn.example.com/seg-1.m4s"), false);
  assert.equal(mod.isDirectMediaFile("https://cdn.example.com/index.m3u8?x=1"), false);
  assert.equal(mod.isDirectMediaFile("https://cdn.example.com/manifest.mpd"), false);
  for (const u of [
    "https://www.kuaishou.com/new-reco",
    "https://www.kuaishou.com/short-video/3xabc",
    "https://www.douyin.com/jingxuan",
    "https://www.bilibili.com/",
  ]) {
    assert.equal(mod.isVideoPage(u), false, `不应把聚合页 / 快手网页当视频页：${u}`);
    assert(mod.pageHint(u).length > 0, `应给出可操作指引：${u}`);
  }
  // 0.3.6：抖音 modal_id 聚合页与 /video/ 详情页在真机上仍报 Fresh cookies，
  // 不再给例外；与引擎 media_page_blocker 一致，统一改走嗅探直链。
  for (const u of [
    "https://www.douyin.com/jingxuan?modal_id=7702008165390421263",
    "https://www.douyin.com/video/7702008165390421263",
  ]) {
    assert.equal(mod.isVideoPage(u), false, `抖音网页不应再当整页解析任务：${u}`);
    assert(mod.pageHint(u).includes("直链"), `抖音应给出直链引导：${u}`);
  }
  assert.equal(mod.isVideoPage("https://www.bilibili.com/video/BV1GysQ6hEgB"), true);
  assert.equal(mod.pageHint("https://www.bilibili.com/video/BV1GysQ6hEgB"), "");
  // 三处判定必须都存在直链短路规则，避免任一层漏判把直链送进 yt-dlp
  assert(/isDirectMediaFile\(/.test(tsSrc), "前端 format.ts 缺少直链短路");
  assert(/is_direct_media_file\(/.test(rsSrc), "Rust looks_like_media 缺少直链短路");

  // ---- 6. 0.3.6：资源噪声过滤 + 整页解析不可用时改走嗅探直链 ----
  assert.equal(typeof mod.bestVideoResource, "function", "缺少导出：bestVideoResource");
  assert.equal(typeof mod.isVideoResource, "function", "缺少导出：isVideoResource");

  // 真机截图里的 manifest.webmanifest（486 B）不能再被列进「本页资源」
  assert.equal(
    mod.classify("https://www.kuaishou.com/manifest.webmanifest", [
      { name: "content-type", value: "application/vnd.apple.installer+json" },
    ]),
    null,
    "PWA manifest 不应出现在资源列表",
  );
  assert.equal(
    mod.classify("https://cdn.example.com/data.json", [
      { name: "content-type", value: "application/json" },
      { name: "content-disposition", value: 'attachment; filename="data.json"' },
    ]),
    "file",
    "带 attachment 的 json 仍是合法下载资源，不能被误杀",
  );
  assert.equal(
    mod.classify("https://cdn.example.com/v.json", [
      { name: "content-type", value: "video/mp4" },
    ]),
    "file",
    "video/* mime 的资源不能被扩展名噪声规则误杀",
  );

  // 快手页面嗅探到 2 条 mp4 + 分片 + manifest：主按钮应选体积最大的 mp4
  const mixed = [
    { url: "https://v2.kuaishou.com/a.mp4", mime: "video/mp4", size: 20 * 1024 * 1024, name: "a.mp4" },
    { url: "https://v2.kuaishou.com/b.mp4", mime: "video/mp4", size: 11 * 1024 * 1024, name: "b.mp4" },
    { url: "https://cdn.example.com/seg-1.m4s", mime: "video/iso.segment", size: 999 * 1024 * 1024 },
    { url: "https://cdn.example.com/index.m3u8", mime: "application/vnd.apple.mpegurl", size: 1 },
    { url: "https://cdn.example.com/audio.mp3", mime: "audio/mpeg", size: 50 * 1024 * 1024 },
    { url: "https://www.kuaishou.com/manifest.webmanifest", mime: "application/manifest+json", size: 486 },
  ];
  assert.equal(
    mod.bestVideoResource(mixed).url,
    "https://v2.kuaishou.com/a.mp4",
    "应选体积最大的视频直链",
  );
  assert.equal(mod.bestVideoResource([]), null, "无视频直链时返回 null，不能伪造任务");

  // 实跑 getPageResources：返回值必须带 bestVideo，且来自真实嗅探缓存
  pageQueryResult = [{ id: 7, url: "https://www.kuaishou.com/new-reco", title: "快手" }];
  pageSessionData = { "res:7": mixed, "stream:7": false };
  const page = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("getPageResources 未回调")), 3000);
    messageListeners[0]({ type: "getPageResources" }, {}, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
  assert(
    page && page.bestVideo && page.bestVideo.url === "https://v2.kuaishou.com/a.mp4",
    "getPageResources 必须返回 bestVideo 供弹窗主按钮使用",
  );
  assert(page.pageHint.length > 0, "快手网页仍应给出不可用提示");

  // 弹窗：整页解析不可用时只能发直链，绝不再发 kind:"media" 的页面任务
  const popupSrc = fs.readFileSync(path.join(ROOT, "browser-extension", "popup.js"), "utf8");
  const handler = popupSrc.slice(
    popupSrc.indexOf('parseVideo.addEventListener("click"'),
    popupSrc.indexOf("clearRes.addEventListener"),
  );
  assert(handler.length > 0, "未找到 popup.js 的 parseVideo 点击处理器");
  const guidance = handler.slice(
    handler.indexOf("if (advice)"),
    handler.indexOf("const url = current.tab"),
  );
  assert(guidance.length > 0, "popup 缺少整页解析不可用的分支");
  assert(!/kind\s*:\s*"media"/.test(guidance), "整页解析不可用时不得再发送 media 页面任务");
  assert(
    /resourcePayload\(best\)/.test(guidance),
    "整页解析不可用时主按钮必须经 resourcePayload 发送嗅探到的视频直链（显式 http）",
  );

  // ---- 7. 0.3.9 收敛：移除「用链接下载」+ 「本页资源」直链显式 kind:"http" ----
  const popupHtml = fs.readFileSync(path.join(ROOT, "browser-extension", "popup.html"), "utf8");
  const popupCss = fs.readFileSync(path.join(ROOT, "browser-extension", "popup.css"), "utf8");
  // 「用链接下载」入口已整段移除：弹窗 DOM / 样式 / 脚本都不再有它。
  assert(!/id="link-input"/.test(popupHtml), "「用链接下载」输入框应已从弹窗移除");
  assert(!/id="link-download"/.test(popupHtml), "「用链接下载」按钮应已从弹窗移除");
  assert(!/link-card/.test(popupHtml), "「用链接下载」卡片应已从弹窗移除");
  assert(!/\.link-card|#link-input|link-row/.test(popupCss), "「用链接下载」样式应已移除");
  assert(!/linkInput|linkDownload|classifyLink/.test(popupSrc), "弹窗脚本不应残留「用链接下载」逻辑");

  const bgSrc = fs.readFileSync(EXT, "utf8");
  // 方案 A 与 classifyLink 裁决链路全部删除，不得残留。
  assert(!/function internalSniff/.test(bgSrc), "background 必须删除 internalSniff（开页嗅探）");
  assert(!/case "openTabForSniff":/.test(bgSrc), "background 必须删除 openTabForSniff");
  assert(!/case "getTabResources":/.test(bgSrc), "background 必须删除 getTabResources");
  assert(!/function pollBestVideo/.test(bgSrc), "background 必须删除 pollBestVideo");
  assert(!/case "classifyLink":/.test(bgSrc), "background 必须删除 classifyLink 裁决");

  // 本页资源：所有下载都经 resourcePayload 显式带 kind:"http"。
  // 这是「本页资源做好了」的关键：抖快探针嗅到的多是无扩展名直链
  // （.../play/?mime_type=video_mp4），若不带 kind，桌面端 handle_capture_conn
  // 会用 looks_like_media 兜底判成 Media 任务，再被 media_page_blocker 拒绝。
  assert(/function resourcePayload/.test(popupSrc), "本页资源需有统一的 resourcePayload 构造器");
  const rpBody = popupSrc.slice(
    popupSrc.indexOf("function resourcePayload"),
    popupSrc.indexOf("function renderResources"),
  );
  assert(/kind:\s*"http"/.test(rpBody), "resourcePayload 必须显式带 kind:\"http\"");
  assert(/referer:/.test(rpBody), "resourcePayload 需携带 referer（防盗链）");
  assert(/filename:/.test(rpBody), "resourcePayload 需携带 filename");
  // 三个弹窗下载入口都走 resourcePayload：单条下载、全部发送、主按钮直链。
  // 用调用点计数（rec 应出现 2 次，best 1 次），比位置正则稳健。
  const recCalls = (popupSrc.match(/resourcePayload\(rec\)/g) || []).length;
  const bestCalls = (popupSrc.match(/resourcePayload\(best\)/g) || []).length;
  assert(recCalls >= 2, `单条 + 全部发送都应走 resourcePayload(rec)，实得 ${recCalls} 次`);
  assert(bestCalls === 1, `主按钮直链应走 resourcePayload(best)，实得 ${bestCalls} 次`);
  assert(
    !/sendDownload\(\{\s*url:\s*rec\.url/.test(popupSrc),
    "不得再绕过 resourcePayload 手写资源 payload（会漏掉 kind:\"http\"）",
  );

  // 实跑：弹窗 sendDownload 一条无扩展名的抖音直链（模拟 resourcePayload 产物），
  // 桌面端收到的 body 必须是 kind:"http" 且 url 原样，绝不能被改写成 media。
  sent.length = 0;
  const sniffDirect = "https://www.douyin.com/aweme/v1/play/?mime_type=video_mp4&token=abc";
  const sniffResult = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sendDownload 未回调")), 3000);
    messageListeners[0](
      {
        type: "sendDownload",
        payload: {
          url: sniffDirect,
          filename: "video.mp4",
          referer: "https://www.douyin.com/",
          kind: "http",
        },
        silent: true,
      },
      {},
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
    );
  });
  assert(sniffResult && sniffResult.ok, "本页资源无扩展名直链应发送成功");
  assert.equal(sent.length, 1, "应只发一次 /api/downloads");
  const sniffBody = JSON.parse(sent[0].init.body);
  assert.equal(sniffBody.kind, "http", "本页资源直链必须以 kind:\"http\" 送达桌面端");
  assert.equal(sniffBody.url, sniffDirect, "直链 url 需原样透传");
  assert.equal(sniffBody.referer, "https://www.douyin.com/", "直链需携带 referer");
  assert.equal(sniffBody.userAgent, "Mozilla/5.0 (FluxDL-Contract-Test)", "仍需注入 UA");

  // 右键菜单「下载此媒体」按菜单类型分流：srcUrl 是直链，显式 http，不走网页判定。
  assert(/info\.menuItemId === MENU_MEDIA/.test(bgSrc), "右键菜单需按 MENU_MEDIA 分流媒体直链");
  const menuMedia = bgSrc.slice(
    bgSrc.indexOf("if (info.menuItemId === MENU_MEDIA)"),
    bgSrc.indexOf("if (info.menuItemId !== MENU_LINK) return;"),
  );
  assert(/kind:\s*"http"/.test(menuMedia), "MENU_MEDIA 直链必须显式 kind:\"http\"");
  assert(!/isUnsupportedPage/.test(menuMedia), "MENU_MEDIA 不得再走网页 unsupported 判定");

  // isUnsupportedPage 仍导出，供右键菜单「下载此链接」分流复用
  assert.equal(typeof mod.isUnsupportedPage, "function", "缺少导出：isUnsupportedPage");
  assert.equal(mod.isUnsupportedPage("https://www.douyin.com/video/7702008165390421263"), true);
  assert.equal(mod.isUnsupportedPage("https://www.kuaishou.com/new-reco"), true);
  assert.equal(mod.isUnsupportedPage("https://www.bilibili.com/video/BV1xx"), false,
    "支持整页解析的站点不应被误判为不支持");

  console.log(
    `PASS 扩展契约：payload=userAgent，导出完好，前后端站点名单一致（${tsSet.size} 个域名），直链短路/聚合页/资源噪声/最佳直链/弹窗引导态/移除「用链接下载」/本页资源直链显式 kind:"http"（含右键媒体）全部通过`,
  );
}

main().catch((error) => {
  console.error(`FAIL 扩展契约检查：${error.message}`);
  process.exitCode = 1;
});
