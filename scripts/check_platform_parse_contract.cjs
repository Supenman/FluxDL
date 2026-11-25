/**
 * 平台结构化解析契约（参考 YunX「一平台一解析器」，落在浏览器扩展探针里）。
 *
 * 纯 Node 跑，不依赖浏览器、不依赖外网：
 *   node scripts/check_platform_parse_contract.cjs
 *
 * 覆盖：
 *   1. 探针纯函数：平台判定 / URL 编码 SSR 解码 / 括号配对抠 JSON
 *   2. parsePlatformMedia：抖音 detail（无扩展名正片 + 清晰度 + 标题/作者）、
 *      快手 INIT_STATE、内联 SSR（_ROUTER_DATA / RENDER_DATA），以及普通页面不误判
 *   3. 噪声排除：封面图 / 图集图片 / 分片 / PWA manifest 不进解析结果
 *   4. install hook：fetch / XHR / 内联脚本真实触发 emit 并携带 media
 *   5. 桥接：sanitizeMedia 白名单、凭证红线、去重、数量上限；buildPayload 透传
 *   6. background：带 media 的 probeResources 端到端入缓存 → 标题文件名 →
 *      primary 标记 → bestVideo 选中该正片；普通 probeResources 行为不变
 *   7. 凭证红线：新增代码不得出现 cookie / Authorization 读取或携带
 *   8. 版本纪律：仍是 0.3.9 / 2.2.2，不 bump
 *
 * 三个源文件都用 new Function 以经典脚本语义加载（仓库根 package.json 是
 * "type":"module"，require(.js) 会走 require(esm)，module 未定义）。
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "browser-extension");
const PROBE = path.join(EXT, "page-probe.js");
const BRIDGE = path.join(EXT, "probe-bridge.js");
const BG = path.join(EXT, "background.js");
const MANIFEST = path.join(EXT, "manifest.json");

const results = [];
function pass(name) {
  results.push(name);
  console.log("  ✓ " + name);
}

function load(file, globals) {
  const src = fs.readFileSync(file, "utf8");
  const moduleObj = { exports: {} };
  const names = ["module", "exports"];
  const values = [moduleObj, moduleObj.exports];
  for (const [k, v] of Object.entries(globals || {})) {
    names.push(k);
    values.push(v);
  }
  const run = new Function(...names, src);
  run(...values);
  return moduleObj.exports;
}

// ------------------------------------------------------------------ //
// 测试数据：抖音 / 快手的真实响应结构与 SSR
// ------------------------------------------------------------------ //
const CDN_PLAY = "https://v3-web.douyinvod.com/2c3a/2026/video/tos/cn/tos-cn-ve-15/abcd?a=1234&token=xyz";
const douyinDetail = JSON.stringify({
  aweme_detail: {
    desc: "周末骑行，风景很好",
    author: { nickname: "骑车的小明" },
    video: {
      play_addr: {
        url_list: [CDN_PLAY, "https://v26-web.douyinvod.com/hi/video/tos/?token=t2"],
        ratio: "720p",
      },
      bit_rate_list: [
        { gear_name: "1080p", play_addr: { url_list: ["https://v26-web.douyinvod.com/hi/1080.mp4"] } },
        { gear_name: "540p", play_addr: { url_list: ["https://v26-web.douyinvod.com/lo/540.mp4"] } },
      ],
      download_addr: { url_list: ["https://v3-web.douyinvod.com/wm/720.mp4"] },
      cover: "https://p3.douyinimg.com/cover.jpeg",
    },
    images: [{ url_list: ["https://p3.douyinimg.com/pic1.jpeg"] }],
  },
});

const ksState = JSON.stringify({
  INIT_STATE: {
    "photo-3xabc": {
      caption: "快手日常",
      userName: "阿花\u3164",
      mainMvUrls: [{ url: "https://v2.kuaishou.com/photo_a.mp4?ssig=abc" }],
      photoUrls: ["https://v1.kuaishou.com/photo_b.mp4"],
      coverUrls: ["https://p2.kuaishou.com/cover.jpg"],
      ext_params: {},
    },
  },
});

const ssrPayload = {
  loaderData: {
    "video_(id)/page": {
      videoInfoRes: {
        item_list: [{
          desc: "SSR 里的视频",
          author: { nickname: "SSR 作者" },
          video: {
            play_addr: { url_list: ["https://v3-web.douyinvod.com/ssr/video/tos/"] },
            cover: "https://p3.douyinimg.com/ssr-cover.jpeg",
          },
        }],
      },
    },
  },
};
const ssrRouter = "window._ROUTER_DATA = " + JSON.stringify(ssrPayload) + ";";
const renderData =
  '<script id="RENDER_DATA" type="application/json">' +
  encodeURIComponent(JSON.stringify({
    app: {
      videoDetail: {
        desc: "RENDER 视频",
        video: { play_addr: { url_list: ["https://v3-web.douyinvod.com/render/video/tos/"] } },
      },
    },
  })) + "</script>";

// ------------------------------------------------------------------ //
// 1) 加载与导出
// ------------------------------------------------------------------ //
const probe = load(PROBE);
const bridge = load(BRIDGE);
for (const fn of [
  "platformOf", "tryParseJson", "extractJsonBlock", "jsonCandidates",
  "findText", "collectWorkNodes", "urlListOf", "isPlatformVideoUrl",
  "workItems", "dedupeItems", "parsePlatformMedia", "install", "makeEmitter",
]) {
  assert.equal(typeof probe[fn], "function", `探针缺少导出：${fn}`);
}
assert.equal(typeof bridge.sanitizeMedia, "function", "桥接缺少 sanitizeMedia");
pass("探针与桥接以经典脚本语义加载，结构化解析纯函数导出齐全");

// ------------------------------------------------------------------ //
// 2) platformOf：接口 URL 与 SSR 特征，普通页面返回 ""
// ------------------------------------------------------------------ //
assert.equal(probe.platformOf("https://www.douyin.com/aweme/v1/web/aweme/detail/", ""), "douyin");
assert.equal(probe.platformOf("https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/", ""), "douyin");
assert.equal(probe.platformOf("https://www.kuaishou.com/graphql", ""), "kuaishou");
assert.equal(probe.platformOf("https://v.m.chenzhongtech.com/fw/photo/1", ""), "kuaishou");
assert.equal(probe.platformOf("", "window._ROUTER_DATA = {};"), "douyin");
assert.equal(probe.platformOf("", "<script id=\"RENDER_DATA\">%7B%7D</script>"), "douyin");
assert.equal(probe.platformOf("", "window.INIT_STATE = {};"), "kuaishou");
assert.equal(probe.platformOf("https://example.com/api/config", ""), "");
assert.equal(probe.platformOf("", JSON.stringify({ config: { apiBase: "https://x/" } })), "");
pass("platformOf：抖音/快手接口与 SSR 特征命中，普通页面无副作用");

// ------------------------------------------------------------------ //
// 3) tryParseJson / extractJsonBlock / jsonCandidates
// ------------------------------------------------------------------ //
assert.deepEqual(probe.tryParseJson('{"a":1}'), { a: 1 });
assert.deepEqual(probe.tryParseJson(encodeURIComponent('{"a":2}')), { a: 2 },
  "URL 编码的 RENDER_DATA 必须能解码");
assert.equal(probe.tryParseJson("not json"), null);
assert.equal(probe.extractJsonBlock('window.X = {"k":"with } brace"}; tail', 0), '{"k":"with } brace"}',
  "引号感知的括号配对不能被字符串里的 } 打断");
const candidates = probe.jsonCandidates(ssrRouter + "\n" + renderData);
assert.equal(candidates.length, 2, "应解析出 _ROUTER_DATA 与 RENDER_DATA 两个 JSON 根");
pass("tryParseJson / extractJsonBlock / jsonCandidates：URL 解码与 SSR 抠取正确");

// ------------------------------------------------------------------ //
// 4) parsePlatformMedia：抖音 detail
// ------------------------------------------------------------------ //
const dyResult = probe.parsePlatformMedia(douyinDetail, "https://www.douyin.com/aweme/v1/web/aweme/detail/");
assert(dyResult, "抖音 detail 应解析出结果");
assert.equal(dyResult.platform, "douyin");
assert.equal(dyResult.title, "周末骑行，风景很好", "标题应取自 desc");
assert.equal(dyResult.author, "骑车的小明", "作者应取自 author.nickname");
const dyUrls = dyResult.items.map((m) => m.url);
assert(dyUrls.includes(CDN_PLAY), "无扩展名、无 MIME 线索的正片直链必须被收录（通用正则做不到）");
assert(dyUrls.includes("https://v26-web.douyinvod.com/hi/1080.mp4"), "1080p 清晰度直链应收录");
assert(dyUrls.includes("https://v26-web.douyinvod.com/lo/540.mp4"), "540p 清晰度直链应收录");
assert.equal(dyResult.items[0].url, CDN_PLAY, "无水印 play_addr 应排在最前");
assert.equal(dyResult.items[0].ratio, "720p", "清晰度应透传");
for (const m of dyResult.items) {
  assert.equal(m.platform, "douyin");
  assert.equal(m.title, dyResult.title);
  assert.equal(m.author, dyResult.author);
}
assert(!dyUrls.some((u) => /douyinimg|\.jpe?g/i.test(u)), "封面与图集图片不得混入");
assert(!dyUrls.some((u) => /\.(m4s|ts|key)(\?|#|$)/i.test(u)), "分片不得混入");
assert.equal(probe.parsePlatformMedia(ksState, "https://www.kuaishou.com/graphql").platform, "kuaishou");
pass("parsePlatformMedia 抖音 detail：无扩展名正片/多清晰度/标题作者全对，图片与分片排除");

// 4b) 快手 INIT_STATE
const ksResult = probe.parsePlatformMedia(ksState, "https://www.kuaishou.com/graphql");
assert(ksResult, "快手 INIT_STATE 应解析出结果");
assert.equal(ksResult.title, "快手日常");
assert.equal(ksResult.author, "阿花", "昵称里的 U+3164 占位空白应剥掉");
assert(ksResult.items.some((m) => m.url.includes("photo_a.mp4")), "mainMvUrls 直链应收录");
assert(ksResult.items.some((m) => m.url.includes("photo_b.mp4")), "photoUrls 直链应收录");
assert(!ksResult.items.some((m) => /cover\.jpg/i.test(m.url)), "封面图片不得混入");
pass("parsePlatformMedia 快手：INIT_STATE 的 mainMvUrls/photoUrls、标题、作者、占位符清理");

// 4c) SSR 内联数据
const routerResult = probe.parsePlatformMedia(ssrRouter, "");
assert(routerResult, "window._ROUTER_DATA 应解析出结果");
assert.equal(routerResult.title, "SSR 里的视频");
assert(routerResult.items.some((m) => m.url.includes("douyinvod.com/ssr/")), "SSR 正片直链应收录");
const renderResult = probe.parsePlatformMedia(renderData, "");
assert(renderResult, "URL 编码的 RENDER_DATA 应解析出结果");
assert.equal(renderResult.title, "RENDER 视频");
assert(renderResult.items.some((m) => m.url.includes("douyinvod.com/render/")), "RENDER_DATA 正片直链应收录");
pass("parsePlatformMedia SSR：_ROUTER_DATA 与 URL 编码 RENDER_DATA 都能取到正片");

// 4d) 普通页面 / 无关 JSON 不误判
assert.equal(probe.parsePlatformMedia('{"config":{"apiBase":"https://x/"}}', "https://example.com/api"), null);
assert.equal(probe.parsePlatformMedia("plain text", ""), null);
assert.equal(probe.parsePlatformMedia("", ""), null);
assert.equal(probe.parsePlatformMedia(JSON.stringify({ video: {} }), "https://x/detail"), null,
  "没有可下载直链时返回 null，不伪造资源");
// 预算：超深对象 / 超大文本不炸
const deep = { v: {} };
let node = deep.v;
for (let i = 0; i < 200; i += 1) { node.next = {}; node = node.next; }
node.desc = "deep";
node.play_addr = { url_list: ["https://v3-web.douyinvod.com/deep/video/tos/"] };
assert.doesNotThrow(() => probe.parsePlatformMedia(JSON.stringify(deep), "https://www.douyin.com/aweme/v1/web/aweme/detail/"),
  "超深 JSON 不应抛错");
assert.doesNotThrow(() => probe.parsePlatformMedia("x".repeat(3 * 1024 * 1024), ""), "超大文本不应抛错");
pass("parsePlatformMedia：普通页面不误判、无直链返回 null、超深/超大文本安全");

// 4e) 结构化 URL 仍做硬校验
assert.equal(probe.isPlatformVideoUrl("https://v3-web.douyinvod.com/x/video/tos/"), true,
  "无扩展名 CDN 正片应放行");
for (const u of [
  "https://p3.douyinimg.com/x.jpeg",
  "https://cdn.example.com/seg-1.m4s",
  "https://cdn.example.com/config.json",
  "https://www.douyin.com/manifest.webmanifest",
  "https://user:pass@cdn.example.com/a.mp4",
  "blob:https://x/abc",
]) {
  assert.equal(probe.isPlatformVideoUrl(u), false, `应排除：${u}`);
}
pass("isPlatformVideoUrl：放行无扩展名正片，排除图片/分片/噪声/凭证/blob");

// ------------------------------------------------------------------ //
// 5) install hook：fetch / XHR / 内联脚本携带 media
// ------------------------------------------------------------------ //
function fakeResponse(body, contentType) {
  return {
    headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? contentType : "") },
    clone() { return this; },
    text: async () => body,
  };
}
function makeWindow() {
  const posted = [];
  const win = {
    location: { href: "https://www.douyin.com/video/7702008165390421263" },
    __posted: posted,
    postMessage: (msg) => posted.push(msg),
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    URL: { createObjectURL: () => "blob:stub" },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() {}
      disconnect() {}
      trigger() { this.cb([]); }
    },
  };
  return win;
}
function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

(async () => {
  // 5a fetch 收到 aweme/detail JSON
  {
    const win = makeWindow();
    win.fetch = async () => fakeResponse(douyinDetail, "application/json");
    const uninstall = probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    await win.fetch("https://www.douyin.com/aweme/v1/web/aweme/detail/");
    await tick();
    const allMedia = win.__posted.flatMap((m) => m.media || []);
    assert(allMedia.some((m) => m.url === CDN_PLAY),
      "fetch hook 必须把结构化正片放进 postMessage 的 media 字段");
    assert(allMedia.some((m) => m.title === "周末骑行，风景很好"), "标题应随 media 一起上报");
    uninstall();
    pass("install fetch：抖音 detail 响应触发 media 上报（标题 + 无扩展名直链）");
  }

  // 5b XHR 收到快手 graphql 响应
  {
    const win = makeWindow();
    class FakeXHR {
      constructor() { this.listeners = {}; this.responseType = ""; this.responseText = ""; }
      addEventListener(ev, cb) { (this.listeners[ev] ||= []).push(cb); }
      open(method, url) { this.__u = url; }
      send() {
        this.responseText = ksState;
        for (const cb of this.listeners.load || []) cb();
      }
    }
    win.XMLHttpRequest = FakeXHR;
    probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    const xhr = new win.XMLHttpRequest();
    xhr.open("GET", "https://www.kuaishou.com/graphql");
    xhr.send();
    await tick();
    const allMedia = win.__posted.flatMap((m) => m.media || []);
    assert(allMedia.some((m) => m.url.includes("photo_a.mp4")), "XHR hook 必须触发 media 上报");
    pass("install XHR：快手 graphql 响应触发 media 上报");
  }

  // 5c 内联 SSR 脚本
  {
    const win = makeWindow();
    const doc = {
      documentElement: {},
      querySelectorAll: () => [{ textContent: ssrRouter }],
    };
    probe.install(win, doc);
    await tick();
    const allMedia = win.__posted.flatMap((m) => m.media || []);
    assert(allMedia.some((m) => m.url.includes("douyinvod.com/ssr/")),
      "内联 SSR 脚本扫描必须触发 media 上报");
    pass("install 内联脚本：window._ROUTER_DATA 首屏扫描触发 media 上报");
  }

  // 5d 普通响应不产生 media（零副作用）
  {
    const win = makeWindow();
    win.fetch = async () => fakeResponse('{"config":{"api":"https://x/"}}', "application/json");
    probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    await win.fetch("https://example.com/api/config");
    await tick();
    for (const m of win.__posted) {
      assert(!Array.isArray(m.media) || m.media.length === 0, "普通页面不应产生结构化条目");
    }
    pass("install：普通页面响应零 media，通用链路不受影响");
  }

  // ---------------------------------------------------------------- //
  // 6) 桥接：sanitizeMedia / buildPayload
  // ---------------------------------------------------------------- //
  const mediaIn = [
    { url: CDN_PLAY, title: "周末骑行", author: "小明", ratio: "720p", platform: "douyin",
      cookie: "SESSION=secret", headers: { Authorization: "Bearer x" } },  // 伪造字段
    { url: CDN_PLAY, title: "重复", platform: "douyin" },                   // 重复 URL
    { url: "https://user:pass@x/a.mp4", title: "凭证", platform: "douyin" },
    { url: "blob:https://x/abc", title: "blob", platform: "douyin" },
    { url: "https://cdn.example.com/a.mp4\u0000evil", title: "控制字符" },
    { url: "https://x/" + "a".repeat(20000) + ".mp4", title: "超长" },
    { url: "https://v26-web.douyinvod.com/hi/1080.mp4", title: "高清", ratio: "1080p", platform: "douyin" },
  ];
  const mediaOut = bridge.sanitizeMedia({ [bridge.TAG]: true, media: mediaIn }, true);
  assert.equal(mediaOut.length, 2, "只应保留 2 条合法的去重条目");
  assert.equal(mediaOut[0].url, CDN_PLAY);
  assert.equal(mediaOut[0].title, "周末骑行");
  assert.equal(mediaOut[0].ratio, "720p");
  assert.equal(mediaOut[0].platform, "detail", "平台字段归一成 detail，不透传原始值");
  for (const m of mediaOut) {
    assert.deepEqual(Object.keys(m).sort(), ["author", "platform", "ratio", "title", "url"],
      "只能透传 5 个白名单字段，绝不携带凭证 / 请求头 / 未知字段");
  }
  assert.deepEqual(bridge.sanitizeMedia({ media: mediaIn }, true), [], "无 TAG 拒绝");
  assert.deepEqual(bridge.sanitizeMedia({ [bridge.TAG]: true, media: mediaIn }, false), [], "异源拒绝");
  const many = Array.from({ length: 100 }, (_, i) => ({
    url: `https://cdn.example.com/v${i}.mp4`, platform: "douyin",
  }));
  assert(bridge.sanitizeMedia({ [bridge.TAG]: true, media: many }, true).length <= bridge.MAX_MEDIA_FORWARD,
    "单次转发必须受 MAX_MEDIA_FORWARD 限制");
  pass("bridge.sanitizeMedia：来源/TAG/URL/去重/白名单/凭证/控制字符/超长/数量上限");

  const payload = bridge.buildPayload(
    { [bridge.TAG]: true, pageUrl: "https://www.douyin.com/video/1", source: "fetch-body" },
    ["https://cdn.example.com/a.mp4"],
    mediaOut,
  );
  assert.equal(payload.type, "probeResources");
  assert.deepEqual(payload.urls, ["https://cdn.example.com/a.mp4"]);
  assert.equal(payload.media.length, 2, "media 应透传给 background");
  assert(!("cookie" in payload) && !("headers" in payload) && !("credentials" in payload),
    "转发负载不得含任何凭证字段");
  const legacy = bridge.buildPayload({ [bridge.TAG]: true, pageUrl: "https://x/" }, ["https://x/a.mp4"]);
  assert(!("media" in legacy), "旧消息形态不带 media 字段，保持完全兼容");
  pass("bridge.buildPayload：media 透传、旧形态兼容、无凭证字段");

  // ---------------------------------------------------------------- //
  // 7) background：带 media 的 probeResources 端到端
  // ---------------------------------------------------------------- //
  let sessionStore = {};
  const sessionStub = {
    get: async (keys) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of arr) if (k in sessionStore) out[k] = sessionStore[k];
      return out;
    },
    set: async (obj) => { Object.assign(sessionStore, obj); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete sessionStore[k]; },
    clear: async () => { sessionStore = {}; },
  };
  const msgListeners = [];
  let pageQueryResult = [];
  const noopListener = { addListener: () => {} };
  const chromeStub = {
    storage: { session: sessionStub, sync: { get: async () => ({ autoCapture: true }), set: async () => {} } },
    tabs: { query: async () => pageQueryResult, onRemoved: noopListener, onUpdated: noopListener },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: { onMessage: { addListener: (cb) => msgListeners.push(cb) }, onInstalled: noopListener,
      getURL: (p) => `chrome-extension://test/${p}`, lastError: null },
    webRequest: { onResponseStarted: noopListener },
    downloads: { onCreated: noopListener, cancel: async () => {}, removeFile: async () => {}, erase: async () => {} },
    contextMenus: { removeAll: () => {}, create: () => {}, onClicked: noopListener },
    notifications: { create: () => {} },
  };
  const bg = load(BG, {
    chrome: chromeStub,
    navigator: { userAgent: "Mozilla/5.0 (Platform-Parse-Test)" },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  assert.equal(typeof bg.mediaFileName, "function", "background 缺少 mediaFileName 导出");

  function callBg(message, sender) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("onMessage 未回调 sendResponse")), 3000);
      msgListeners[0](message, sender || {}, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
    });
  }
  const senderTab = { tab: { id: 7, url: "https://www.douyin.com/video/7702008165390421263" } };

  // 7a mediaFileName
  assert.equal(
    bg.mediaFileName({ url: CDN_PLAY, title: "周末骑行/风景:很好", author: "小明", ratio: "720p" }),
    "周末骑行 风景 很好 - 小明 - 720p.mp4",
    "标题需清理非法文件名字符并附上作者/清晰度",
  );
  assert.equal(
    bg.mediaFileName({ url: "https://cdn.example.com/fallback.mp4", title: "" }),
    "fallback.mp4",
    "无标题时回退到 nameFromUrl",
  );
  pass("mediaFileName：标题清理、作者/清晰度拼接、无标题回退");

  // 7b 端到端：media + 通用 urls 混合
  sessionStore = {};
  const addResp = await callBg({
    type: "probeResources",
    urls: [
      "https://v26-web.douyinvod.com/hi/1080.mp4",   // 与 media 第 2 条同 URL → merge
      "https://cdn.example.com/index.m3u8",          // → stream
      "https://user:pass@cdn.example.com/evil.mp4",  // → 凭证拒绝
    ],
    media: [
      { url: CDN_PLAY, title: "周末骑行", author: "小明", ratio: "720p", platform: "detail" },
      { url: "https://v26-web.douyinvod.com/hi/1080.mp4", title: "周末骑行", author: "小明", ratio: "1080p", platform: "detail" },
    ],
    pageUrl: "https://www.douyin.com/video/7702008165390421263",
  }, senderTab);
  assert(addResp && addResp.ok, `probeResources 失败：${JSON.stringify(addResp)}`);
  assert.equal(addResp.added, 3, "2 条结构化正片 + 1 条通用直链应入队");
  assert.equal(addResp.streams, 1, "m3u8 应触发 markStream");

  pageQueryResult = [{ id: 7, url: "https://www.douyin.com/video/7702008165390421263", title: "抖音" }];
  const page = await callBg({ type: "getPageResources" }, senderTab);
  const rec = (page.resources || []).find((r) => r.url === CDN_PLAY);
  assert(rec, "无扩展名正片必须出现在「本页资源」列表");
  assert.equal(rec.via, "detail", "来源应标记为 detail");
  assert.equal(rec.primary, true, "结构化正片应带 primary 标记");
  assert.equal(rec.name, "周末骑行 - 小明 - 720p.mp4", "列表里应显示作品标题而非 URL 尾段");
  assert.equal(rec.title, "周末骑行");
  assert.equal(rec.author, "小明");
  assert.equal(rec.mime, "video/mp4", "无扩展名直链需给定视频 mime，供 bestVideo 识别");
  assert.equal(rec.referer, "https://www.douyin.com/video/7702008165390421263", "referer 应取 pageUrl");
  assert(page.bestVideo && page.bestVideo.url === CDN_PLAY,
    "主按钮应优先选中结构化正片，而不是按体积猜");
  assert(!(page.resources || []).some((r) => r.url.includes("user:pass")), "凭证 URL 不得入缓存");
  assert.equal(page.hasStream, true);
  pass("端到端：media 入缓存 → 标题文件名/primary/mime/referer → bestVideo 选中正片");

  // 7c 与 webRequest 真实大体积直链共存时，primary 仍优先
  assert.equal(bg.bestVideoResource([
    { url: "https://cdn.example.com/big.mp4", mime: "video/mp4", size: 50_000_000 },
    { url: CDN_PLAY, mime: "video/mp4", size: 0, primary: true },
  ]).url, CDN_PLAY, "页面接口明确的正片应优先于体积更大的其它直链");
  // 无 primary 时回到原规则（体积优先）
  assert.equal(bg.bestVideoResource([
    { url: "https://cdn.example.com/big.mp4", mime: "video/mp4", size: 50_000_000 },
    { url: CDN_PLAY, mime: "video/mp4", size: 0 },
  ]).url, "https://cdn.example.com/big.mp4", "无 primary 时行为与既有规则一致");
  pass("bestVideoResource：primary 优先，无 primary 时完全兼容既有体积规则");

  // 7d 旧 probeResources（无 media）行为不变
  sessionStore = {};
  const legacyResp = await callBg({
    type: "probeResources",
    urls: ["https://v3-web.douyinvod.com/x/video.mp4?a=1", "https://cdn.example.com/index.m3u8"],
    pageUrl: "https://www.douyin.com/video/7702008165390421263",
  }, senderTab);
  assert(legacyResp && legacyResp.ok);
  assert.equal(legacyResp.added, 1, "旧消息只处理 urls，added 语义不变");
  assert.equal(legacyResp.streams, 1);
  pass("兼容：不带 media 的旧 probeResources 行为完全不变");

  // ---------------------------------------------------------------- //
  // 8) 凭证红线 + 版本纪律
  // ---------------------------------------------------------------- //
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }
  const forbidden = [
    /\bdocument\s*\.\s*cookie\b/i,
    /\bwithCredentials\b/i,
    /\bsetRequestHeader\s*\(/i,
    /\bCOOKIE_DOMAINS\b/i,
    /["']authorization["']\s*:/i,
    /fetch\s*\([^)]*credentials:\s*"include"/i,
  ];
  for (const file of [PROBE, BRIDGE]) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    for (const re of forbidden) {
      assert(!re.test(code), `${path.basename(file)} 出现凭证相关代码：${re}`);
    }
  }
  const bgCode = stripComments(fs.readFileSync(BG, "utf8"));
  for (const re of [/\bdocument\s*\.\s*cookie\b/i, /\bCOOKIE_DOMAINS\b/i]) {
    assert(!re.test(bgCode), `background.js 出现凭证相关代码：${re}`);
  }
  pass("凭证红线：结构化解析链路不读取、不携带任何凭证");

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "应用版本格式合法");
  assert.equal(tauriConf.version, pkg.version, "tauri.conf.json 与 package.json 版本必须一致");
  assert.equal(manifest.version, "2.2.2", "扩展版本仍为 2.2.2（本次未动扩展）");
  assert.equal(manifest.minimum_chrome_version, "102");
  const main = manifest.content_scripts.find((c) => c.world === "MAIN");
  assert(main && main.js.includes("page-probe.js") && main.all_frames, "MAIN world 探针注入不变");
  pass(`版本纪律：应用 ${pkg.version} / 扩展 2.2.2 一致，manifest 注入结构不变`);

  console.log("\n" + "=".repeat(64));
  console.log(`PASS 平台结构化解析契约：${results.length} 组断言全部通过`);
  console.log("=".repeat(64));
})().catch((error) => {
  console.error(`\nFAIL 平台结构化解析契约：${error.stack || error.message}`);
  process.exitCode = 1;
});
