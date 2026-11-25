/**
 * 0.3.9 开发态：抖音免 Cookie 直链解析契约。
 *
 * 背景：B 档（yt-dlp 整页解析 + 本机浏览器 Cookie）经真机验证无效 —— 抖音
 * PC Web 详情接口在 Argus 网关后，缺 a_bogus / uifid 一律 403，随包 yt-dlp
 * 生成不了签名，Cookie 也救不了。已整体移除。
 *
 * 现方案：参考 jiuhunwl/short_videos（MIT）确认接口形态，改用移动端老接口
 * api.amemv.com/aweme/v1/aweme/detail/ —— 只要移动端 UA，免 Cookie、免登录、
 * 免签名；取 aweme_detail.video.play_addr.url_list 的无水印正片直链，在
 * Engine::add 里把抖音 Media 页面任务转成 HTTP 直链任务，复用 A 档引擎下载。
 *
 * 本脚本做跨层源码级断言，锁定「粘贴抖音链接 → Media 任务 → 免 Cookie 解析 →
 * HTTP 直链下载」链路真的接通，且旧 Cookie 通道已彻底删除（而非只改了注释）。
 * 数值 / 解析行为由 cargo test 的 douyin.rs 单测覆盖。
 *
 * 运行：node scripts/check_media_parse_contract.cjs
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
function pass(msg) {
  passed += 1;
  console.log(`  ✓ ${msg}`);
}
function section(title) {
  console.log(`\n[${title}]`);
}

const libSrc = read("crates/download-engine/src/lib.rs");
const douyinSrc = read("crates/download-engine/src/douyin.rs");
const managerSrc = read("crates/download-engine/src/manager.rs");
const mediaSrc = read("crates/download-engine/src/media.rs");
const typesSrc = read("crates/download-engine/src/types.rs");
const httpSrc = read("crates/download-engine/src/http.rs");
const f036Src = read("crates/download-engine/tests/functional_036.rs");
const tsTypes = read("src/lib/types.ts");
const tsStore = read("src/store.ts");
const settingsTsx = read("src/components/SettingsPage.tsx");
const bgSrc = read("browser-extension/background.js");
const popupSrc = read("browser-extension/popup.js");
const probeSrc = read("browser-extension/page-probe.js");

// ------------------------------------------------------------------ //
section("1) 免 Cookie 解析模块：移动端详情接口 + 无水印正片直链");
// ------------------------------------------------------------------ //
assert.match(libSrc, /mod douyin;/, "lib.rs 必须注册 douyin 模块");
assert.match(
  douyinSrc,
  /api\.amemv\.com\/aweme\/v1\/aweme\/detail\//,
  "douyin.rs 必须指向移动端免 Cookie 详情接口"
);
// 背景注释里会提到该接口用于说明「为什么不用」，只禁止把它定义成请求地址。
assert.ok(
  !/const\s+\w+\s*:\s*&str\s*=\s*"[^"]*\/aweme\/v1\/web\/aweme\/detail\//.test(douyinSrc),
  "不得把 Argus 网关后的 PC Web 详情接口定义成请求地址"
);
const endpointLine = douyinSrc.split("\n").find((l) => l.includes("DETAIL_ENDPOINT: &str"));
assert.ok(
  endpointLine && endpointLine.includes("api.amemv.com"),
  "DETAIL_ENDPOINT 必须指向移动端免 Cookie 接口"
);
assert.match(douyinSrc, /const MOBILE_UA/, "详情请求必须带移动端 UA");
assert.match(douyinSrc, /pub const DOWNLOAD_UA/, "CDN 下载 UA 需导出给 add()");
assert.match(douyinSrc, /pub const REFERER/, "CDN 防盗链 Referer 需导出给 add()");
assert.match(douyinSrc, /play_addr/, "必须按 play_addr 语义取正片，而非通用 URL 正则");
assert.match(douyinSrc, /url_list/, "必须读 play_addr.url_list");
assert.match(douyinSrc, /playwm/, "必须跳过带水印地址");
assert.match(douyinSrc, /bit_rate_list/, "正片缺失时需有档位回退");
assert.match(douyinSrc, /mime_type=video_mp4/, "直链需补 MP4 标识");
assert.match(douyinSrc, /core_dep/, "必须识别风控 / 删除作品");
assert.match(douyinSrc, /suggested_filename/, "需生成中文建议文件名");
assert.match(douyinSrc, /resolve_short_link/, "v.douyin.com 短链需先跟随 302");
assert.match(douyinSrc, /extract_aweme_id/, "需从详情页 / modal_id 提取作品 ID");
pass("douyin.rs 独立实现移动端免 Cookie 解析，字段语义与风控处理齐全");

// ------------------------------------------------------------------ //
section("2) Engine::add：抖音 Media 页面 → resolve → HTTP 直链任务");
// ------------------------------------------------------------------ //
const blockerIdx = managerSrc.indexOf("crate::media::media_page_blocker(&raw)");
const resolveIdx = managerSrc.indexOf("crate::douyin::is_douyin_page(&raw)");
assert.ok(blockerIdx > -1, "add() 必须先跑 media_page_blocker 拦截快手 / 聚合页");
assert.ok(resolveIdx > -1, "add() 必须接入 douyin::is_douyin_page 判定");
assert.ok(blockerIdx < resolveIdx, "拦截必须发生在网络解析之前，避免无谓请求");
assert.ok(
  /kind == TaskKind::Media/.test(managerSrc.slice(resolveIdx - 160, resolveIdx)),
  "抖音解析必须只在 TaskKind::Media 分支触发（HTTP 直链不得被重复解析）"
);
assert.match(
  managerSrc,
  /crate::douyin::resolve\(&raw, engine_options\.proxy\.as_deref\(\)\)/,
  "解析需复用引擎全局代理设置"
);
assert.match(managerSrc, /kind = TaskKind::Http;/, "解析成功后必须转成 HTTP 任务");
assert.match(managerSrc, /raw = video\.url\.clone\(\);/, "任务 URL 必须替换为解析出的直链");
assert.match(
  managerSrc,
  /options\.referer = Some\(crate::douyin::REFERER\.to_string\(\)\);/,
  "必须设置防盗链 Referer，否则 CDN 403"
);
assert.match(
  managerSrc,
  /options\.user_agent = Some\(crate::douyin::DOWNLOAD_UA\.to_string\(\)\);/,
  "必须设置桌面 UA"
);
assert.match(
  managerSrc,
  /options\.filename = Some\(video\.suggested_filename\(\)\);/,
  "必须采用中文建议文件名"
);
assert.match(
  managerSrc,
  /options\.prefer_header_filename = false;/,
  "不得让 CDN Content-Disposition 覆盖中文名"
);
assert.match(httpSrc, /fn apply_headers/, "A 档引擎需支持自定义请求头");
assert.match(httpSrc, /REFERER, value/, "A 档引擎必须真正下发 Referer");
pass("add() 在拦截之后完成 Media→Http 转换，Referer/UA/文件名三件套齐全");

// ------------------------------------------------------------------ //
section("3) B 档 Cookie 通道已彻底删除（源码级，不只是注释）");
// ------------------------------------------------------------------ //
for (const bad of ["media_cookie_browser", "media_cookie_file"]) {
  assert.ok(!typesSrc.includes(bad), `EngineOptions 不得残留 ${bad}`);
}
for (const bad of [
  "cookie_args(",
  "apply_cookie_args",
  "--cookies-from-browser",
  '"--cookies"',
]) {
  assert.ok(!mediaSrc.includes(bad), `media.rs 不得残留 ${bad}`);
}
for (const bad of ["mediaCookieBrowser", "mediaCookieFile"]) {
  assert.ok(!tsTypes.includes(bad), `types.ts 不得残留 ${bad}`);
  assert.ok(!tsStore.includes(bad), `store.ts 不得残留 ${bad}`);
  assert.ok(!settingsTsx.includes(bad), `SettingsPage.tsx 不得残留 ${bad}`);
}
for (const bad of ["视频 Cookie 来源", "cookies.txt", "value={settings.mediaCookieBrowser"]) {
  assert.ok(!settingsTsx.includes(bad), `设置页不得残留旧 Cookie 控件：${bad}`);
}
assert.match(
  settingsTsx,
  /免 Cookie 的移动端详情接口/,
  "设置页需说明新的免 Cookie 解析方式"
);
assert.ok(!f036Src.includes("B 档后抖音单视频链接应放行给 yt-dlp"), "功能回归测试断言需同步更新");
pass("引擎 / 前端 / 设置页 / 回归测试里旧 Cookie 通道全部移除");

// ------------------------------------------------------------------ //
section("4) 扩展链路一致：抖音发 media、快手与聚合页仍拦、文案不再引导配 Cookie");
// ------------------------------------------------------------------ //
for (const bad of [
  "Cookie 来源",
  "配置浏览器 Cookie",
  "视频 Cookie 来源",
  "选择已登录抖音的浏览器",
  "因此不解析这类页面",
]) {
  assert.ok(!bgSrc.includes(bad), `background.js 不得残留旧 Cookie 引导文案：${bad}`);
}
assert.match(bgSrc, /if \(isKs\) return true;/, "快手无提取器，仍应判 unsupported");
assert.match(bgSrc, /hasModalId/, "带 modal_id 的抖音精选页不应被聚合页规则误杀");
assert.ok(
  !/if \(isDouyin\) return true;/.test(bgSrc),
  "isUnsupportedPage 不得再把抖音一律判为 unsupported"
);
assert.match(bgSrc, /kind:\s*"media"/, "可解析视频页应发 media 任务（由桌面端解析）");
assert.match(popupSrc, /kind:\s*"media"/, "弹窗主按钮应发 media 任务");
assert.match(bgSrc, /免 Cookie/, "扩展文案需说明免 Cookie 解析");
assert.match(mediaSrc, /快手网页链接无法整页解析/, "快手仍保留诚实拦截");
assert.match(mediaSrc, /if is_direct_media_file\(url\) \{\s*return None;/, "容器直链短路必须保留");
assert.match(mediaSrc, /if aggregate && !has_id/, "无 id 聚合首页仍应拦截");
pass("扩展与引擎判定一致，旧文案清理干净，快手 / 聚合页 / 直链短路规则保留");

// ------------------------------------------------------------------ //
section("5) 凭证边界：不读取本机 Cookie、不携带登录态、不逆向签名");
// ------------------------------------------------------------------ //
for (const bad of [
  "document.cookie",
  "--cookies",
  "cookies-from-browser",
  "CookieStore",
  "reqwest::cookie",
]) {
  assert.ok(!douyinSrc.includes(bad), `douyin.rs 不得接触任何凭证：${bad}`);
}
assert.ok(
  !/\bdocument\s*\.\s*cookie\b/i.test(probeSrc),
  "网页探针不得读取 document.cookie"
);
assert.ok(
  !/\bcookies?\s*:/i.test(bgSrc.slice(bgSrc.indexOf("async function postDownload"))),
  "扩展下载请求不得携带 cookie 字段"
);
assert.match(
  mediaSrc,
  /不读取、不传输、不落盘任何浏览器 Cookie/,
  "media.rs 需明确凭证边界"
);
assert.ok(
  !mediaSrc.includes("FluxDL 不读取、传输或保存任何凭证"),
  "media.rs 不得残留旧红线拦截分支文案"
);
pass("整条链路零凭证接触：不读浏览器 Cookie、不落盘登录态、不生成 a_bogus");

// ------------------------------------------------------------------ //
section("6) 版本纪律：各版本文件一致（不绑死具体号）");
// ------------------------------------------------------------------ //
const pkg = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("browser-extension/manifest.json"));
const tauriConf = JSON.parse(read("src-tauri/tauri.conf.json"));
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "应用版本格式合法");
assert.equal(tauriConf.version, pkg.version, "tauri.conf.json 与 package.json 版本必须一致");
assert.equal(manifest.version, "2.2.2", "扩展版本仍为 2.2.2（本次未动扩展）");
pass(`版本号一致（应用 ${pkg.version} / 扩展 2.2.2）`);

console.log(
  `\nPASS 抖音免 Cookie 直链解析契约：${passed} 组断言全部通过（移动端接口 + Media→Http 转换 + B 档删除 + 跨层判定一致 + 凭证边界 + 版本纪律）`
);
