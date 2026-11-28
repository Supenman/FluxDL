/**
 * 0.3.7 候选：MAIN-world 探针链路契约检查。
 *
 * 不依赖浏览器、不依赖外网，纯 Node 跑：
 *   node scripts/check_probe_contract.cjs
 *
 * 与 check_extension_contract.cjs 的区别：那个只验「扩展↔桌面端」既有契约，
 * 本脚本验新增的「页面探针 → 桥接 → background」三段链路，覆盖：
 *   1. 探针纯函数：URL 归一化/噪声过滤/JSON body/内联脚本/HLS 清单/预算与去重
 *   2. 探针 hook：fetch / XHR / createObjectURL / MutationObserver 真实触发 emit
 *   3. world 判别降级与幂等安装
 *   4. 桥接：来源校验、字段白名单、去重、转发负载
 *   5. background：probeResourceKind 复用 classify；probeResources 消息端到端
 *      入缓存并被 bestVideoResource 选中
 *   6. manifest 结构与「不升版本」纪律
 *   7. 凭证红线：源码里不得出现任何 cookie / 凭据读取或携带
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

/** 以经典脚本语义加载，注入需要的全局，返回 module.exports。 */
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
// 1) 加载探针 / 桥接纯函数（不注入 window → isRealPage=false，不自动安装）
// ------------------------------------------------------------------ //
const probe = load(PROBE);
const bridge = load(BRIDGE);
for (const fn of [
  "normalizeUrl", "looksLikeMedia", "extractUrls", "extractFromBody",
  "extractFromManifest", "scanValue", "dedupe", "makeEmitter", "install",
]) {
  assert.equal(typeof probe[fn], "function", `探针缺少导出：${fn}`);
}
for (const fn of ["sanitizeMessage", "buildPayload", "install"]) {
  assert.equal(typeof bridge[fn], "function", `桥接缺少导出：${fn}`);
}
pass("探针与桥接以经典脚本语义加载，纯函数导出齐全");

// ------------------------------------------------------------------ //
// 2) normalizeUrl：归一化与硬校验
// ------------------------------------------------------------------ //
assert.equal(
  probe.normalizeUrl("https://v2.kuaishou.com/abc.mp4?token=x"),
  "https://v2.kuaishou.com/abc.mp4?token=x",
);
assert.equal(
  probe.normalizeUrl("https:\\/\\/cdn.douyin.com\\/x.mp4"),
  "https://cdn.douyin.com/x.mp4",
  "JSON 转义斜杠应还原",
);
assert.equal(
  probe.normalizeUrl('https://cdn.example.com/a.mp4",'),
  "https://cdn.example.com/a.mp4",
  "尾部引号/逗号应清掉",
);
assert.equal(probe.normalizeUrl("blob:https://x/abc"), "", "blob: 地址拒绝");
assert.equal(probe.normalizeUrl("data:video/mp4;base64,AAAA"), "", "data: 地址拒绝");
assert.equal(probe.normalizeUrl("/video/123"), "", "相对地址拒绝");
assert.equal(probe.normalizeUrl("javascript:alert(1)"), "", "非 http 协议拒绝");
assert.equal(probe.normalizeUrl("https://user:pass@cdn.example.com/a.mp4"), "", "带 user:pass@ 拒绝（凭证红线）");
assert.equal(probe.normalizeUrl("https://x/a.mp4\u0000evil"), "", "控制字符拒绝");
assert.equal(probe.normalizeUrl("https://x/" + "a".repeat(20000) + ".mp4"), "", "超长 URL 拒绝");
pass("normalizeUrl：转义还原/尾部清理/协议/凭证/控制字符/超长全部按契约");

// ------------------------------------------------------------------ //
// 3) looksLikeMedia：媒体判定与噪声过滤
// ------------------------------------------------------------------ //
for (const u of [
  "https://v2.kuaishou.com/abc.mp4",
  "https://cdn.douyin.com/x.mp4?token=a",
  "https://cdn.example.com/index.m3u8?x=1",
  "https://cdn.example.com/manifest.mpd",
  "https://cdn.example.com/a.mp4?token=x.json",   // 查询串里的 .json 不能误杀
]) {
  assert.equal(probe.looksLikeMedia(u), true, `应识别为媒体：${u}`);
}
// 抖音/快手无扩展名但带视频 MIME 线索
assert.equal(
  probe.looksLikeMedia("https://aweme.snssdk.com/aweme/v1/play/?video_id=1&mime_type=video_mp4"),
  true,
  "mime_type=video_mp4 的无扩展名直链应识别",
);
for (const u of [
  "https://www.kuaishou.com/manifest.webmanifest",
  "https://cdn.example.com/config.json",
  "https://cdn.example.com/app.js.map",
  "https://cdn.example.com/seg-1.m4s",           // 分片
  "https://cdn.example.com/seg-1.ts",            // 分片
  "https://cdn.example.com/enc.key",             // 密钥
  "https://cdn.example.com/logo.png",
  "a.b.c.mp4",                                   // 命名空间式属性链
]) {
  assert.equal(probe.looksLikeMedia(u), false, `不应识别为媒体：${u}`);
}
pass("looksLikeMedia：容器/清单/视频 MIME 线索收录，噪声/分片/密钥/属性链排除");

// ------------------------------------------------------------------ //
// 4) extractFromBody：抖音 / 快手风格 JSON，以及内联脚本纯文本
// ------------------------------------------------------------------ //
const douyinBody = JSON.stringify({
  aweme_detail: {
    video: {
      play_addr: {
        url_list: [
          "https://aweme.snssdk.com/aweme/v1/play/?video_id=7702008165390421263&ratio=720p&mime_type=video_mp4",
          "https://v3-web.douyinvod.com/2c3a/2026/video.mp4?a=1234&mime_type=video_mp4",
        ],
      },
      cover: "https://p3.douyinimg.com/xxx.jpeg",           // 图片噪声
      bitrate_list: [{ play_addr: { url_list: ["https://v26-web.douyinvod.com/hi/720.mp4?x=1"] } }],
    },
    desc: "看这个 https://cdn.example.com/trailer.mp4 也很好",  // 字符串内嵌 URL
  },
});
const douyinFound = probe.extractFromBody(douyinBody);
assert(douyinFound.some((u) => u.includes("v3-web.douyinvod.com") && u.includes(".mp4")),
  "抖音 play_addr.url_list 的 mp4 直链必须被抓到");
assert(douyinFound.some((u) => u.includes("mime_type=video_mp4")),
  "抖音无扩展名但带视频 MIME 的直链必须被抓到");
assert(douyinFound.some((u) => u.includes("v26-web.douyinvod.com")),
  "嵌套 bitrate_list 里的直链必须被抓到");
assert(douyinFound.some((u) => u === "https://cdn.example.com/trailer.mp4"),
  "描述字符串里内嵌的 URL 必须被抓到");
assert(!douyinFound.some((u) => u.includes("douyinimg.com")),
  "图片 URL 不能被当媒体上报");
assert(!douyinFound.some((u) => u.includes("manifest.webmanifest")));
pass("extractFromBody：抖音 JSON（含嵌套数组、描述内嵌、视频 MIME 线索）正确提取且过滤图片");

const kuaishouBody = JSON.stringify({
  photo: {
    mainMvUrls: [{ url: "https://v2.kuaishou.com/photo_a.mp4?ssig=abc" }],
    photoUrls: ["https://v1.kuaishou.com/photo_b.mp4?ssig=def"],
    manifest: "https://www.kuaishou.com/manifest.webmanifest",
  },
});
const ksFound = probe.extractFromBody(kuaishouBody);
assert(ksFound.some((u) => u.includes("photo_a.mp4")), "快手 mainMvUrls 直链应抓到");
assert(ksFound.some((u) => u.includes("photo_b.mp4")), "快手 photoUrls 直链应抓到");
assert(!ksFound.some((u) => u.includes("webmanifest")), "PWA manifest 不应上报");
pass("extractFromBody：快手 JSON（mainMvUrls/photoUrls）提取正确且过滤 PWA manifest");

assert(probe.extractFromBody('<script>var u="https://cdn.example.com/clip.mp4";</script>')
  .includes("https://cdn.example.com/clip.mp4"),
  "非 JSON 的内联脚本文本也应走纯文本正则提取");

// 预算：超长文本不炸、超深对象不炸
const deep = { v: {} };
let node = deep.v;
for (let i = 0; i < 200; i += 1) { node.next = {}; node = node.next; }
node.url = "https://cdn.example.com/deep.mp4";
assert.doesNotThrow(() => probe.extractFromBody(JSON.stringify(deep)), "超深 JSON 不应抛错");
const huge = "x".repeat(3 * 1024 * 1024);
assert.doesNotThrow(() => probe.extractFromBody(huge), "超大文本不应抛错");
const many = { list: Array.from({ length: 500 }, (_, i) => `https://cdn.example.com/v${i}.mp4`) };
assert(probe.extractFromBody(JSON.stringify(many)).length <= probe.MAX_EMIT,
  "单次提取条数必须受 MAX_EMIT 限制");
pass("extractFromBody：纯文本提取/超深对象/超大文本/条数预算全部安全");

// ------------------------------------------------------------------ //
// 5) extractFromManifest：HLS 相对行解析成绝对地址，分片不收
// ------------------------------------------------------------------ //
const master = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080",
  "https://cdn.example.com/1080/index.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=800000",
  "720p/index.m3u8",
  "seg0.ts",
  "seg1.m4s",
  "https://cdn.example.com/key.key",
].join("\n");
const mf = probe.extractFromManifest(master, "https://cdn.example.com/hls/master.m3u8");
assert(mf.includes("https://cdn.example.com/1080/index.m3u8"), "绝对子清单应收");
assert(mf.includes("https://cdn.example.com/hls/720p/index.m3u8"), "相对子清单应按 baseUrl 解析");
assert(!mf.some((u) => /\.(ts|m4s|key)$/.test(u)), "分片与密钥不得上报");
assert.deepEqual(probe.extractFromManifest("<html>not a playlist</html>", "https://x/"), [],
  "非清单文本应返回空");
pass("extractFromManifest：HLS 主清单相对行→绝对 URL，分片/密钥/非清单正确排除");

// ------------------------------------------------------------------ //
// 6) dedupe / makeEmitter
// ------------------------------------------------------------------ //
assert.deepEqual(probe.dedupe(["a", "a", "b", "a"]), ["a", "b"]);
const emitted = [];
const emit = probe.makeEmitter((msg) => emitted.push(msg), () => "https://www.douyin.com/video/1");
const first = emit(["https://x/a.mp4", "https://x/a.mp4"], "fetch-body");
assert.deepEqual(first, ["https://x/a.mp4"], "同一 URL 只上报一次");
assert.equal(emitted[0][probe.TAG], true, "postMessage 必须带专用 TAG");
assert.equal(emitted[0].pageUrl, "https://www.douyin.com/video/1", "pageUrl 用于 referer");
assert.equal(emit(["https://x/a.mp4"], "again").length, 0, "全局去重：重复 URL 不再上报");
pass("dedupe / makeEmitter：去重、TAG、pageUrl、全局 seen 均正确");

// ------------------------------------------------------------------ //
// 7) install：真实 hook fetch / XHR / createObjectURL / MutationObserver
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
    setTimeout: (fn) => { fn(); return 1; },     // 同步执行，便于断言
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
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

(async () => {
  // 7a fetch 读 JSON body
  {
    const win = makeWindow();
    const origFetch = async () => fakeResponse(douyinBody, "application/json");
    win.fetch = origFetch;
    const uninstall = probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    await win.fetch("https://www.douyin.com/aweme/v1/web/aweme/detail/");
    await tick();
    const all = win.__posted.flatMap((m) => m.urls || []);
    assert(all.some((u) => u.includes("v3-web.douyinvod.com") && u.includes(".mp4")),
      "fetch hook 必须从 JSON body 抓到抖音 mp4 直链");
    uninstall();
    assert.equal(win.fetch, origFetch, "uninstall 必须恢复原始 fetch");
    pass("install：fetch hook 读 JSON body 抓到直链，uninstall 完整恢复");
  }

  // 7b 请求 URL 本身就是媒体直链
  {
    const win = makeWindow();
    win.fetch = async () => fakeResponse("", "application/json");
    probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    await win.fetch("https://v2.kuaishou.com/direct.mp4?ssig=x");
    await tick();
    const all = win.__posted.flatMap((m) => m.urls || []);
    assert(all.includes("https://v2.kuaishou.com/direct.mp4?ssig=x"),
      "fetch 请求 URL 是直链时应直接上报");
    pass("install：fetch 请求 URL 本身是直链时直接上报");
  }

  // 7c XHR
  {
    const win = makeWindow();
    class FakeXHR {
      constructor() { this.listeners = {}; this.responseType = ""; this.responseText = ""; }
      addEventListener(ev, cb) { (this.listeners[ev] ||= []).push(cb); }
      open(method, url) { this.__m = method; this.__u = url; }
      send() {
        this.responseText = kuaishouBody;
        for (const cb of this.listeners.load || []) cb();
      }
    }
    win.XMLHttpRequest = FakeXHR;
    probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    const xhr = new win.XMLHttpRequest();
    xhr.open("GET", "https://www.kuaishou.com/graphql");
    xhr.send();
    await tick();
    const all = win.__posted.flatMap((m) => m.urls || []);
    assert(all.some((u) => u.includes("photo_a.mp4")),
      "XHR hook 必须从响应文本抓到快手直链");
    pass("install：XHR hook 从响应文本抓到直链");
  }

  // 7d createObjectURL(Blob) 里的内联清单
  {
    const win = makeWindow();
    probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    win.URL.createObjectURL({
      size: master.length,
      text: async () => master,
    });
    await tick();
    const all = win.__posted.flatMap((m) => m.urls || []);
    assert(all.some((u) => u.includes("1080/index.m3u8")),
      "createObjectURL 里的内联 HLS 清单应被扫描");
    pass("install：createObjectURL(Blob) 内联清单被扫描");
  }

  // 7e MutationObserver 内联 <script>
  {
    const win = makeWindow();
    const doc = {
      documentElement: {},
      querySelectorAll: () => [{ textContent: 'window.__mp4="https://cdn.example.com/inline.mp4";' }],
    };
    probe.install(win, doc);   // setTimeout 同步 → 首屏扫描立即执行
    const all = win.__posted.flatMap((m) => m.urls || []);
    assert(all.includes("https://cdn.example.com/inline.mp4"),
      "内联 <script> 里的直链应被首屏扫描抓到");
    pass("install：MutationObserver 首屏扫描内联 <script> 抓到直链");
  }

  // 7f world 降级：ISOLATED（有 chrome.runtime.id）不安装
  {
    const win = makeWindow();
    const origFetch = async () => fakeResponse("", "application/json");
    win.fetch = origFetch;
    win.chrome = { runtime: { id: "extension-id" } };
    probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    assert.equal(win.fetch, origFetch,
      "Chrome<111 把 MAIN 脚本降级注入 ISOLATED 时必须跳过安装，零副作用");
    pass("install：world 判别降级（ISOLATED 有 chrome.runtime.id 时跳过 hook）");
  }

  // 7g 幂等
  {
    const win = makeWindow();
    win.fetch = async () => fakeResponse("", "application/json");
    const first = probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    const patchedFetch = win.fetch;
    probe.install(win, { documentElement: {}, querySelectorAll: () => [] });
    assert.equal(win.fetch, patchedFetch, "第二次 install 不得重复 hook");
    first();
    pass("install：幂等，重复调用不叠加 hook");
  }

  // ---------------------------------------------------------------- //
  // 8) 桥接：sanitizeMessage / buildPayload / install 转发
  // ---------------------------------------------------------------- //
  assert.deepEqual(bridge.sanitizeMessage({ urls: ["https://x/a.mp4"] }, true), [],
    "无 TAG 的消息拒绝");
  assert.deepEqual(bridge.sanitizeMessage({ [bridge.TAG]: true, urls: ["https://x/a.mp4"] }, false), [],
    "非本窗口来源拒绝");
  const sanitized = bridge.sanitizeMessage({
    [bridge.TAG]: true,
    urls: [
      "https://cdn.example.com/a.mp4",
      "https://cdn.example.com/a.mp4",           // 去重
      "blob:https://x/abc",                      // 非 http(s)
      "data:video/mp4;base64,AAAA",
      "https://user:pass@x/b.mp4",               // 凭证
      "https://cdn.example.com/\u0000evil.mp4",   // 控制字符
      "https://cdn.example.com/" + "x".repeat(20000) + ".mp4", // 超长
      "https://cdn.example.com/b.mp4",
    ],
  }, true);
  assert.deepEqual(sanitized, ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"],
    "桥接必须去重并过滤非 http(s)/凭证/控制字符/超长");
  const manyUrls = Array.from({ length: 100 }, (_, i) => `https://cdn.example.com/v${i}.mp4`);
  assert(bridge.sanitizeMessage({ [bridge.TAG]: true, urls: manyUrls }, true).length <= bridge.MAX_FORWARD,
    "桥接单次转发必须受 MAX_FORWARD 限制");
  pass("bridge.sanitizeMessage：来源/TAG/http(s)/去重/凭证/控制字符/超长/数量上限");

  const payload = bridge.buildPayload(
    { [bridge.TAG]: true, pageUrl: "https://www.douyin.com/video/1", source: "fetch-body" },
    ["https://cdn.example.com/a.mp4"],
  );
  assert.equal(payload.type, "probeResources");
  assert.equal(payload.pageUrl, "https://www.douyin.com/video/1");
  assert.deepEqual(payload.urls, ["https://cdn.example.com/a.mp4"]);
  assert(!("cookie" in payload) && !("headers" in payload) && !("credentials" in payload),
    "转发负载不得含任何凭证字段");
  pass("bridge.buildPayload：type/pageUrl/urls 正确，无凭证字段");

  {
    const sent = [];
    const win = {
      addEventListener: (ev, cb) => { if (ev === "message") win.__handler = cb; },
      removeEventListener: () => {},
      chrome: {},
    };
    const runtime = { sendMessage: (msg) => sent.push(msg), lastError: null };
    bridge.install(win, runtime);
    assert.equal(typeof win.__handler, "function", "桥接应注册 message 监听");
    win.__handler({ source: win, data: { [bridge.TAG]: true, urls: ["https://cdn.example.com/a.mp4"], pageUrl: "https://x/" } });
    assert.equal(sent.length, 1, "合法消息应转发一次");
    assert.equal(sent[0].type, "probeResources");
    win.__handler({ source: {}, data: { [bridge.TAG]: true, urls: ["https://cdn.example.com/b.mp4"] } });
    assert.equal(sent.length, 1, "其它窗口来源的消息不得转发");
    pass("bridge.install：合法消息转发、异源消息拦截");
  }

  // ---------------------------------------------------------------- //
  // 9) background：stub 加载 + probeResourceKind + probeResources 端到端
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
    tabs: {
      query: async () => pageQueryResult,
      onRemoved: noopListener, onUpdated: noopListener,
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: {
      onMessage: { addListener: (cb) => msgListeners.push(cb) },
      onInstalled: noopListener,
      getURL: (p) => `chrome-extension://test/${p}`,
      lastError: null,
    },
    webRequest: { onResponseStarted: noopListener },
    downloads: { onCreated: noopListener, cancel: async () => {}, removeFile: async () => {}, erase: async () => {} },
    contextMenus: { removeAll: () => {}, create: () => {}, onClicked: noopListener },
    notifications: { create: () => {} },
  };
  const bg = load(BG, {
    chrome: chromeStub,
    navigator: { userAgent: "Mozilla/5.0 (Probe-Contract-Test)" },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  assert.equal(typeof bg.inferProbeMime, "function", "background 缺少 inferProbeMime 导出");
  assert.equal(typeof bg.probeResourceKind, "function", "background 缺少 probeResourceKind 导出");
  assert(msgListeners.length > 0, "background 未注册 onMessage 监听");

  // 判定复用 classify：与 webRequest 完全一致
  assert.equal(bg.probeResourceKind("https://v2.kuaishou.com/a.mp4"), "file");
  assert.equal(bg.probeResourceKind("https://aweme.snssdk.com/play/?id=1&mime_type=video_mp4"), "file",
    "无扩展名但带视频 MIME 线索应判为可下载 file");
  assert.equal(bg.probeResourceKind("https://cdn.example.com/index.m3u8"), "stream");
  assert.equal(bg.probeResourceKind("https://cdn.example.com/manifest.mpd"), "stream");
  assert.equal(bg.probeResourceKind("https://www.kuaishou.com/manifest.webmanifest"), null,
    "PWA manifest 噪声必须被 classify 过滤");
  assert.equal(bg.probeResourceKind("https://cdn.example.com/config.json"), null);
  // 0.3.7 修复：分片 / 密钥不是完整视频，探针不上报，background 也不得收录。
  // classify 本身不能改（webRequest 仍需把真实 .m4s 请求标记为 stream），
  // 所以这一层短路只作用于 probeResources 消息。
  for (const u of [
    "https://cdn.example.com/seg-1.m4s",
    "https://cdn.example.com/seg-1.ts",
    "https://cdn.example.com/seg-1.m2ts",
    "https://cdn.example.com/enc.key",
  ]) {
    assert.equal(bg.probeResourceKind(u), null, `分片/密钥不得收录：${u}`);
  }
  pass("probeResourceKind 复用 classify：file/stream/噪声/分片与 webRequest 判定完全一致");

  // 探针侧 looksLikeMedia 与 background 侧 probeResourceKind 的收录面必须一致
  const consistency = [
    ["https://v2.kuaishou.com/a.mp4", true],
    ["https://aweme.snssdk.com/play/?id=1&mime_type=video_mp4", true],
    ["https://cdn.example.com/index.m3u8", true],
    ["https://www.kuaishou.com/manifest.webmanifest", false],
    ["https://cdn.example.com/config.json", false],
    ["https://cdn.example.com/seg-1.m4s", false],
    ["https://cdn.example.com/seg-1.ts", false],
    ["https://cdn.example.com/seg-1.m2ts", false],
    ["https://cdn.example.com/enc.key", false],
    ["https://cdn.example.com/logo.png", false],
  ];
  for (const [u, expectMedia] of consistency) {
    assert.equal(probe.looksLikeMedia(u), expectMedia, `探针判定不一致：${u}`);
    assert.equal(bg.probeResourceKind(u) !== null, expectMedia, `background 判定不一致：${u}`);
  }
  pass("探针侧与 background 侧对同一批 URL 的收录面一致（无规则分裂）");

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

  // 端到端：探针消息 → background 入缓存 → getPageResources 返回 → bestVideo 选中
  sessionStore = {};
  const addResp = await callBg({
    type: "probeResources",
    urls: [
      "https://v3-web.douyinvod.com/x/video.mp4?a=1",
      "https://aweme.snssdk.com/aweme/v1/play/?video_id=9&mime_type=video_mp4",
      "https://cdn.example.com/index.m3u8",                  // → stream
      "https://www.kuaishou.com/manifest.webmanifest",        // → 过滤
      "https://user:pass@cdn.example.com/evil.mp4",           // → 凭证拒绝
      "blob:https://x/abc",                                   // → 非 http 拒绝
    ],
    pageUrl: "https://www.douyin.com/video/7702008165390421263",
  }, senderTab);
  assert(addResp && addResp.ok, `probeResources 失败：${JSON.stringify(addResp)}`);
  assert.equal(addResp.added, 2, "只应有 2 条可下载直链入缓存");
  assert.equal(addResp.streams, 1, "m3u8 应触发 1 次 markStream");

  pageQueryResult = [{ id: 7, url: "https://www.douyin.com/video/7702008165390421263", title: "抖音" }];
  const page = await callBg({ type: "getPageResources" }, senderTab);
  const pageUrls = (page.resources || []).map((r) => r.url);
  assert(pageUrls.includes("https://v3-web.douyinvod.com/x/video.mp4?a=1"),
    "探针直链必须出现在 getPageResources 的资源列表");
  assert(pageUrls.includes("https://aweme.snssdk.com/aweme/v1/play/?video_id=9&mime_type=video_mp4"),
    "带视频 MIME 线索的无扩展名直链必须出现在资源列表");
  assert(!pageUrls.some((u) => u.includes("webmanifest") || u.includes("user:pass") || u.startsWith("blob:")),
    "噪声/凭证/blob 不得进入资源列表");
  assert.equal(page.hasStream, true, "m3u8 应标记 hasStream");
  assert(page.bestVideo && page.bestVideo.url === "https://v3-web.douyinvod.com/x/video.mp4?a=1",
    "bestVideo 应选中探针发现的 mp4 直链，供弹窗主按钮一键下载");
  const probeRec = page.resources.find((r) => r.url === "https://v3-web.douyinvod.com/x/video.mp4?a=1");
  assert.equal(probeRec.via, "probe", "资源应标记来源 via=probe");
  assert.equal(probeRec.referer, "https://www.douyin.com/video/7702008165390421263",
    "referer 应取 pageUrl，保证防盗链站点可下载");
  pass("端到端：probeResources 入缓存 → getPageResources → hasStream/bestVideo/referer/via 全链路正确");

  // 体积未知的探针记录：主按钮目标不应受 addResource 的 LIFO 插入顺序影响。
  const probeApi = { url: "https://aweme.snssdk.com/aweme/v1/play/?video_id=9&mime_type=video_mp4", mime: "video/mp4", size: 0 };
  const probeFile = { url: "https://v3-web.douyinvod.com/x/video.mp4?a=1", mime: "video/mp4", size: 0 };
  assert.equal(bg.bestVideoResource([probeApi, probeFile]).url, probeFile.url);
  assert.equal(bg.bestVideoResource([probeFile, probeApi]).url, probeFile.url,
    "两条体积未知的探针直链，无论插入顺序都应选中带容器扩展名的那条");
  const big = { url: "https://cdn.example.com/big.mp4", mime: "video/mp4", size: 20_000_000 };
  assert.equal(bg.bestVideoResource([probeFile, big]).url, big.url,
    "有真实体积的 webRequest 记录仍应优先于体积未知的探针记录");
  pass("bestVideoResource：体积降序为主，体积未知时按容器扩展名确定优先级");

  // sender.tab 缺失时拒绝（防伪造）
  const badResp = await callBg({ type: "probeResources", urls: ["https://x/a.mp4"] }, {});
  assert.equal(badResp.ok, false, "无 sender.tab 时不得受理");
  // 消息体自带 tabId 也不能被信任
  const forged = await callBg({ type: "probeResources", tabId: 999, urls: ["https://x/a.mp4"] }, {});
  assert.equal(forged.ok, false, "不得信任消息体自带的 tabId");
  pass("background 只信 sender.tab.id，拒绝伪造 tabId 与无标签页上下文");

  // ---------------------------------------------------------------- //
  // 10) manifest 结构与版本纪律
  // ---------------------------------------------------------------- //
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  // 0.3.7 正式发版：探针随包发出，扩展版本随功能合入小版本递增。
  // 0.3.9 扩展功能变动（本页资源直链显式 http、移除「用链接下载」入口）→ 2.2.2。
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "扩展版本号合法");
  assert.equal(manifest.minimum_chrome_version, "102",
    "保留 102：Chrome<111 不认识 world 字段，探针自动降级，webRequest 嗅探不受影响");
  assert(manifest.permissions.includes("webRequest"), "webRequest 嗅探必须保留");
  assert(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 2,
    "应注册两条 content_scripts");
  const main = manifest.content_scripts.find((c) => c.world === "MAIN");
  const isolated = manifest.content_scripts.find((c) => !c.world || c.world === "ISOLATED");
  assert(main && main.js.includes("page-probe.js") && main.run_at === "document_start" && main.all_frames,
    "MAIN world 探针应 document_start + all_frames 注入");
  assert(isolated && isolated.js.includes("probe-bridge.js") && isolated.run_at === "document_start",
    "ISOLATED 桥接应 document_start 注入");
  for (const f of ["page-probe.js", "probe-bridge.js"]) {
    assert(fs.existsSync(path.join(EXT, f)), `缺少文件：${f}`);
  }
  pass("manifest：MAIN/ISOLATED 双 world 注册、扩展版本 2.2.2 与最低 Chrome 102");

  // ---------------------------------------------------------------- //
  // 11) 凭证红线：源码（去掉注释后）不得出现任何 cookie / 凭据操作
  // ---------------------------------------------------------------- //
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }
  const forbidden = [
    /\bdocument\s*\.\s*cookie\b/i,
    /\bwithCredentials\b/i,
    /\bsetRequestHeader\s*\(/i,
    /\bgetCookie\s*\(/i,
    /\bnetscapeCookies\b/i,
    /\bCOOKIE_DOMAINS\b/i,
    /\bcookie\s*[:=]/i,
    /fetch\s*\([^)]*credentials/i,
    /["']authorization["']\s*:/i,
  ];
  for (const file of [PROBE, BRIDGE]) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    for (const re of forbidden) {
      assert(!re.test(code), `${path.basename(file)} 出现凭证相关代码：${re}`);
    }
  }
  // background 新增的 probeResources 分支同样不得引入凭证（全文件扫描）
  const bgCode = stripComments(fs.readFileSync(BG, "utf8"));
  for (const re of [/\bdocument\s*\.\s*cookie\b/i, /\bnetscapeCookies\b/i, /\bCOOKIE_DOMAINS\b/i]) {
    assert(!re.test(bgCode), `background.js 出现凭证相关代码：${re}`);
  }
  pass("凭证红线：新增代码无 cookie/Authorization/withCredentials/setRequestHeader 等操作");

  // ---------------------------------------------------------------- //
  // 12) 0.3.9 本页资源增强：归一化分组 / 元数据探测 / DOM+performance 补漏
  // ---------------------------------------------------------------- //
  assert.equal(typeof bg.dedupeKey, "function", "background 缺少 dedupeKey 导出");
  assert.equal(typeof bg.metadataState, "function", "background 缺少 metadataState 导出");
  assert.equal(typeof bg.metadataFromResponse, "function", "background 缺少 metadataFromResponse 导出");
  assert.equal(typeof bg.probeMetadata, "function", "background 缺少 probeMetadata 导出");
  assert.equal(typeof bg.mergeResource, "function", "background 缺少 mergeResource 导出");
  assert.equal(typeof probe.extractFromPerformance, "function", "探针缺少 extractFromPerformance");
  assert.equal(typeof probe.extractFromMediaElements, "function", "探针缺少 extractFromMediaElements");

  // 12a 归一化：签名 / 时效参数变化归一到同一组，语义参数与清晰度保留
  const dk1 = bg.dedupeKey("https://cdn.example.com/v.mp4?token=aaa&expires=123&video_id=9&ratio=720p");
  const dk2 = bg.dedupeKey("https://cdn.example.com/v.mp4?token=bbb&expires=999&video_id=9&ratio=720p");
  assert.equal(dk1, dk2, "仅签名 / 时效参数变化时应归一到同一组");
  assert.notEqual(dk1, bg.dedupeKey("https://cdn.example.com/v.mp4?token=aaa&video_id=10&ratio=720p"),
    "不同 video_id 不得误并成一行");
  assert.notEqual(dk1, bg.dedupeKey("https://cdn.example.com/v.mp4?token=aaa&video_id=9&ratio=1080p"),
    "不同清晰度参数不得误并成一行");
  assert.notEqual(dk1, bg.dedupeKey("https://other.example.com/v.mp4?video_id=9&ratio=720p"),
    "不同 host 不得误并");
  assert.equal(bg.dedupeKey("https://user:pass@x/a.mp4"), "https://user:pass@x/a.mp4",
    "带 user:pass@ 的 URL 原样返回，不参与分组（凭证红线）");
  pass("dedupeKey：签名归一、语义参数与清晰度保留、凭证 URL 不参与分组");

  // 12b 状态三态：403 / 超时 / 5xx 一律 unknown，绝不误杀
  for (const s of [200, 206, 302]) assert.equal(bg.metadataState(s), "ok", `${s} 应为 ok`);
  for (const s of [404, 410]) assert.equal(bg.metadataState(s), "dead", `${s} 应为 dead`);
  for (const s of [0, 401, 403, 405, 429, 500, 503, undefined, null, "NA"]) {
    assert.equal(bg.metadataState(s), "unknown", `${s} 不得误杀，应为 unknown`);
  }
  pass("metadataState：2xx/3xx=ok、404/410=dead、防盗链与超时一律 unknown");

  // 12c 响应头解析：补体积 / 类型 / 文件名 / Accept-Ranges
  function metaResponse(status, headers) {
    return {
      status,
      headers: { get: (n) => headers[String(n).toLowerCase()] || "" },
    };
  }
  const okMeta = bg.metadataFromResponse(metaResponse(200, {
    "content-length": "20480000",
    "content-type": "video/mp4; charset=binary",
    "content-disposition": 'attachment; filename="clip.mp4"',
    "accept-ranges": "bytes",
  }));
  assert.equal(okMeta.state, "ok");
  assert.equal(okMeta.size, 20480000, "应从 content-length 补回真实体积");
  assert.equal(okMeta.mime, "video/mp4");
  assert.equal(okMeta.name, "clip.mp4", "应从 content-disposition 补回真实文件名");
  assert.equal(okMeta.ranges, true, "应识别 Accept-Ranges: bytes");
  const deniedMeta = bg.metadataFromResponse(metaResponse(403, { "content-length": "1234" }));
  assert.equal(deniedMeta.state, "unknown");
  assert.equal(deniedMeta.size, 0, "403 防盗链页面的长度不能当文件体积采信");
  assert.equal(bg.metadataFromResponse(null).state, "unknown", "无响应对象应安全退化");
  assert.equal(bg.metadataFromResponse({ status: 200 }).state, "ok", "无 headers 的 stub 不应抛错");
  assert.equal(bg.parseTotalLength("", "bytes 0-0/9999"), 9999, "206 的 Content-Range 应能兜底总量");
  pass("metadataFromResponse：体积/mime/文件名/ranges 提取，403 不采信体积，stub 安全退化");

  // 12d 探测请求凭证红线：实跑 probeMetadata，验证 fetch 参数
  const metaCalls = [];
  const bgProbe = load(BG, {
    chrome: chromeStub,
    navigator: { userAgent: "Probe-Test" },
    fetch: async (url, init) => {
      metaCalls.push({ url, init });
      return metaResponse(200, { "content-length": "1024", "content-type": "video/mp4" });
    },
  });
  const metaResult = await bgProbe.probeMetadata("https://cdn.example.com/a.mp4");
  assert.equal(metaCalls.length, 1, "probeMetadata 应只发一次请求");
  assert.equal(metaCalls[0].init.method, "HEAD", "优先轻量 HEAD");
  assert.equal(metaCalls[0].init.credentials, "omit", "探测必须显式 omit 凭证");
  assert.equal(metaCalls[0].init.referrerPolicy, "no-referrer", "探测不得携带 referer 上下文");
  assert(!metaCalls[0].init.headers, "HEAD 请求不得带自定义头");
  assert.equal(metaResult.state, "ok");
  assert.equal(metaResult.size, 1024);
  // HEAD 不支持时降级一次 Range GET
  metaCalls.length = 0;
  const bgProbe405 = load(BG, {
    chrome: chromeStub,
    navigator: { userAgent: "Probe-Test" },
    fetch: async (url, init) => {
      metaCalls.push({ url, init });
      return metaResponse(metaCalls.length === 1 ? 405 : 206, { "content-range": "bytes 0-0/4096" });
    },
  });
  const fallback = await bgProbe405.probeMetadata("https://cdn.example.com/b.mp4");
  assert.equal(metaCalls.length, 2, "405 应降级一次 Range GET");
  assert.equal(metaCalls[1].init.headers.Range, "bytes=0-0");
  assert.equal(fallback.size, 4096);
  pass("probeMetadata：credentials=omit / no-referrer / HEAD 优先 / 405 降级 Range GET");

  // 12e performance 补漏：只收媒体直链，噪声与 blob 全部排除
  const perfFound = probe.extractFromPerformance([
    { name: "https://cdn.example.com/a.mp4" },
    { name: "https://cdn.example.com/config.json" },
    { name: "https://cdn.example.com/seg-1.m4s" },
    "https://cdn.example.com/b.mp4?token=x",
    { name: "blob:https://x/abc" },
    { name: "https://cdn.example.com/logo.png" },
  ]);
  assert(perfFound.includes("https://cdn.example.com/a.mp4"), "performance 直链应补回");
  assert(perfFound.includes("https://cdn.example.com/b.mp4?token=x"), "字符串型 entry 也应识别");
  assert(!perfFound.some((u) => /\.(json|m4s|png)/.test(u) || u.startsWith("blob:")),
    "performance 噪声 / 分片 / blob 不得上报");
  assert.deepEqual(probe.extractFromPerformance(null), [], "非数组输入应返回空");
  pass("extractFromPerformance：补漏媒体直链，过滤噪声/分片/blob，非数组安全");

  // 12f DOM 媒体元素补漏：相对地址按 base 解析、blob/图片过滤、getAttribute 兜底
  const domDoc = {
    querySelectorAll: (sel) => {
      assert.equal(sel, "video, audio, source", "应扫描 video/audio/source 三类元素");
      return [
        { currentSrc: "https://cdn.example.com/direct.mp4", src: "" },
        { src: "/rel/clip.mp4" },
        { getAttribute: (a) => (a === "src" ? "https://cdn.example.com/attr.mp4" : "") },
        { src: "blob:https://x/1" },
        { src: "https://cdn.example.com/pic.png" },
      ];
    },
  };
  const domFound = probe.extractFromMediaElements(domDoc, "https://www.example.com/page/");
  assert(domFound.includes("https://cdn.example.com/direct.mp4"), "video.currentSrc 应补回");
  assert(domFound.includes("https://www.example.com/rel/clip.mp4"), "相对 src 应按 baseUrl 解析");
  assert(domFound.includes("https://cdn.example.com/attr.mp4"), "getAttribute(src) 应兜底");
  assert(!domFound.some((u) => u.startsWith("blob:") || /\.png/.test(u)),
    "DOM blob / 图片不得上报");
  assert.deepEqual(probe.extractFromMediaElements(null, "https://x/"), [], "无 doc 应返回空");
  assert.deepEqual(probe.extractFromMediaElements({ querySelectorAll: () => { throw new Error("denied"); } }, "https://x/"), [],
    "querySelectorAll 抛错应安全退化");
  pass("extractFromMediaElements：currentSrc/src/getAttribute、相对解析、blob/图片过滤、异常退化");

  // 12g 合并同组资源时保留真实响应头数据，绝不被探针的空字段覆盖
  const merged = bg.mergeResource(
    { url: "u", size: 2048, mime: "video/mp4", name: "real.mp4", referer: "https://r/", meta: { state: "ok" }, at: 1 },
    { url: "u", size: 0, mime: "", name: "", referer: "", variants: [], at: 2 },
  );
  assert.equal(merged.size, 2048, "真实体积不得被 0 覆盖");
  assert.equal(merged.mime, "video/mp4");
  assert.equal(merged.name, "real.mp4");
  assert.equal(merged.referer, "https://r/");
  assert.equal(merged.meta.state, "ok");
  assert.equal(merged.at, 1);
  pass("mergeResource：真实响应头字段优先，同组合并不丢体积/mime/文件名/referer");

  // 12h 端到端：归一化同组的两条直链只入一行，备用地址收进 variants
  sessionStore = {};
  const groupResp = await callBg({
    type: "probeResources",
    urls: [
      "https://cdn.example.com/movie.mp4?token=aaa&expires=1&video_id=7",
      "https://cdn.example.com/movie.mp4?token=bbb&expires=2&video_id=7",
      "https://cdn.example.com/other.mp4?video_id=8",
    ],
    pageUrl: "https://www.example.com/video/7",
  }, senderTab);
  assert(groupResp && groupResp.ok, `group probeResources 失败：${JSON.stringify(groupResp)}`);
  const groupPage = await callBg({ type: "getPageResources" }, senderTab);
  assert.equal(groupPage.resources.length, 2, "仅签名不同的两条镜像应合并成一行");
  const grouped = groupPage.resources.find((r) => r.url.includes("movie.mp4"));
  assert(grouped, "主行应保留 movie.mp4 主地址");
  assert.equal(grouped.variants.length, 1, "另一条镜像应作为备用地址");
  assert(grouped.variants[0].url.includes("token=bbb"), "备用地址应保留原始完整 URL");
  assert.equal(grouped.dedupeKey, bg.dedupeKey(grouped.url), "主行应带归一化 key");
  pass("端到端：签名镜像归一成一行 + variants 备用地址，不同 video_id 不合并");

  // 12i 源码级：探测排队挂在入队链路，且凭证红线不破
  const bgFull = fs.readFileSync(BG, "utf8");
  assert(/scheduleMetadataProbe\(tabId, url\)/.test(bgFull), "probeResources 应对新直链排队元数据探测");
  assert(/case "refreshMetadata":/.test(bgFull), "应支持弹窗主动刷新校验状态");
  assert(/credentials:\s*"omit"/.test(bgFull), "探测必须显式 omit 凭证");
  assert(!/credentials:\s*"include"/.test(bgFull), "探测不得携带凭证");
  assert(!/withCredentials/.test(bgFull), "探测不得使用 withCredentials");
  pass("源码：探测排队 / refreshMetadata 消息 / credentials=omit 红线");

  console.log("\n" + "=".repeat(64));
  console.log(`PASS 探针链路契约：${results.length} 组断言全部通过`);
  console.log("=".repeat(64));
})().catch((error) => {
  console.error(`\nFAIL 探针链路契约：${error.stack || error.message}`);
  process.exitCode = 1;
});
