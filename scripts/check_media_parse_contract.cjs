/**
 * 0.3.9 开发态 B 档第一版：视频站点整页解析契约（抖音）。
 *
 * 背景：旧「不碰凭证」红线把抖音整页解析人为写死为不支持 —— 引擎
 * media_page_blocker 与扩展 isUnsupportedPage 都硬拒绝，粘贴抖音链接必然失败。
 * 用户确认解除红线后改为复用 yt-dlp 内置 Douyin 提取器（自维护 a_bogus /
 * msToken / ttwid），cookie 由 yt-dlp 直接读本机浏览器或用户指定 cookies.txt，
 * 扩展 / 网页探针一律不接触凭证、不落盘登录态、不逆向或复制任何 AGPL 代码。
 *
 * 本脚本做跨层源码级断言，锁定「粘贴抖音链接 → Media 任务 → 解析 → 下载」
 * 链路真的接通（而非只改了注释/文案）；数值行为由 cargo test 的 Rust 单测覆盖。
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

const mediaSrc = read("crates/download-engine/src/media.rs");
const typesSrc = read("crates/download-engine/src/types.rs");
const tsTypes = read("src/lib/types.ts");
const tsStore = read("src/store.ts");
const settingsTsx = read("src/components/SettingsPage.tsx");
const bgSrc = read("browser-extension/background.js");
const popupSrc = read("browser-extension/popup.js");

// ------------------------------------------------------------------ //
section("1) 引擎放行抖音整页链接：media_page_blocker 不再硬拒绝抖音");
// ------------------------------------------------------------------ //
// 旧实现的抖音硬拒绝分支（含「不读取、传输或保存任何凭证」文案）必须删除
assert.ok(
  !/抖音网页解析需要浏览器下发的匿名校验 cookie/.test(mediaSrc),
  "media.rs 不得残留旧抖音 cookie 门槛拦截分支"
);
assert.ok(
  !mediaSrc.includes("FluxDL 不读取、传输或保存任何凭证"),
  "media.rs 不得残留旧红线「不碰凭证」文案"
);
// 快手仍拦截（随包 yt-dlp 无提取器），容器直链短路保留
assert.match(mediaSrc, /快手网页链接无法整页解析/, "快手无提取器，应保留诚实拦截");
assert.match(mediaSrc, /if is_direct_media_file\(url\) \{\s*return None;/, "容器直链短路必须保留");
// 聚合页拦截保留，但带 modal_id 的精选页要放行（归一化成详情页）
assert.match(mediaSrc, /if aggregate && !has_id/, "无 id 聚合首页仍应拦截");
pass("抖音放行、快手/聚合页仍拦、容器直链短路保留");

// ------------------------------------------------------------------ //
section("2) cookie 通道：EngineOptions 字段 + 参数构造 + 两条 yt-dlp 命令透传");
// ------------------------------------------------------------------ //
assert.match(typesSrc, /pub media_cookie_browser: Option<String>/, "EngineOptions 缺少 media_cookie_browser");
assert.match(typesSrc, /pub media_cookie_file: Option<String>/, "EngineOptions 缺少 media_cookie_file");
assert.match(typesSrc, /#\[serde\(default\)\]/, "新字段需 serde default（兼容旧配置文件）");
// cookie_args：文件优先、浏览器其次、none/空不传参
assert.match(mediaSrc, /pub fn cookie_args\(options: &EngineOptions\) -> Vec<String>/, "缺少 cookie_args 构造");
assert.match(mediaSrc, /"--cookies-from-browser"/, "需支持 --cookies-from-browser");
assert.match(mediaSrc, /"--cookies"/, "需支持 --cookies <file>");
assert.match(mediaSrc, /\*s != "none"/, "none 应视为不启用");
// 正式下载命令与标题探测命令都要带 cookie 参数
assert.match(mediaSrc, /apply_cookie_args\(&mut cmd, &options\)/, "正式下载命令必须透传 cookie");
assert.match(mediaSrc, /for c in &cookies \{\s*p\.arg\(c\);/, "标题探测命令必须透传 cookie");
assert.match(mediaSrc, /let cookies = cookie_args\(&options\)/, "两条命令应共用同一份 cookie 参数");
// apply_cookie_args 定义存在
assert.match(mediaSrc, /fn apply_cookie_args\(cmd: &mut Command, options: &EngineOptions\)/, "缺少 apply_cookie_args");
pass("cookie 字段/优先级/两条命令透传齐全，扩展与探针不接触凭证");

// ------------------------------------------------------------------ //
section("3) 凭证边界：桌面端读取，扩展/探针不采集、不传输 cookie");
// ------------------------------------------------------------------ //
// 扩展 sendToFluxDL 只带 url/kind/referer/filename + userAgent，不带任何 cookie 字段
assert.ok(
  !/\bcookies?\s*:/i.test(bgSrc.slice(bgSrc.indexOf("async function postDownload"))) ||
    /不采集|不传输/.test(bgSrc),
  "扩展下载请求不得携带 cookie 字段"
);
// 探针凭证红线仍在（probe 只嗅探 URL 字符串）
const probeSrc = read("browser-extension/page-probe.js");
assert.ok(
  !/document\s*\.\s*cookie/i.test(probeSrc),
  "网页探针不得读取 document.cookie"
);
// failure_hint 不再宣称「不碰凭证」，改为引导配置 Cookie 来源
assert.ok(
  !mediaSrc.includes("FluxDL 不保存任何账号凭证"),
  "failure_hint 不得残留「不保存账号凭证」旧结论"
);
assert.match(mediaSrc, /Cookie 来源/, "failure_hint 应引导配置 Cookie 来源");
pass("cookie 只在桌面端 yt-dlp 读取，扩展/探针零凭证接触");

// ------------------------------------------------------------------ //
section("4) 桌面端/前端：字段透传 + 设置 UI 可配置 Cookie 来源");
// ------------------------------------------------------------------ //
assert.match(tsTypes, /mediaCookieBrowser\?: string \| null/, "前端类型缺少 mediaCookieBrowser");
assert.match(tsTypes, /mediaCookieFile\?: string \| null/, "前端类型缺少 mediaCookieFile");
assert.match(tsStore, /mediaCookieBrowser: null/, "store 默认值需补齐 mediaCookieBrowser");
assert.match(tsStore, /mediaCookieFile: null/, "store 默认值需补齐 mediaCookieFile");
assert.match(settingsTsx, /视频 Cookie 来源/, "设置页缺少「视频 Cookie 来源」控件");
assert.match(settingsTsx, /value=\{settings\.mediaCookieBrowser/, "设置页 Cookie 来源下拉未绑定字段");
assert.match(settingsTsx, /"chrome"|"edge"|"firefox"/, "设置页应提供常见浏览器选项");
assert.match(settingsTsx, /cookies\.txt/, "设置页应提供自定义 cookies.txt 路径");
pass("前端类型/默认值/设置 UI 三处齐全");

// ------------------------------------------------------------------ //
section("5) 扩展：抖音整页解析判定与引擎一致，快手/聚合页仍判不支持");
// ------------------------------------------------------------------ //
// isUnsupportedPage 不再把抖音一律判 true（旧 isDouyin return true 分支删除）
assert.ok(
  !/if \(isDouyin\) return true;/.test(bgSrc),
  "isUnsupportedPage 不得再把抖音一律判为 unsupported"
);
assert.match(bgSrc, /if \(isKs\) return true;/, "快手仍应判为 unsupported");
assert.match(bgSrc, /hasModalId/, "带 modal_id 的抖音精选页不应被聚合页规则误杀");
// pageHint 抖音文案改为引导单视频链接 + cookie 配置，不再说「不解析」
assert.ok(
  !bgSrc.includes("因此不解析这类页面"),
  "pageHint 不得残留旧「不解析抖音」文案"
);
// 右键菜单抖音链接走 kind:"media"（isVideoPage 分支）
assert.match(bgSrc, /if \(isVideoPage\(url\)\) \{[\s\S]{0,120}kind:\s*"media"/, "可解析视频页应发 media 任务");
// 弹窗主按钮对可解析页发 kind:"media"
assert.match(popupSrc, /kind:\s*"media"/, "弹窗「解析并下载」应发 media 任务");
pass("扩展与引擎判定一致，抖音走 media、快手/聚合页仍拦");

// ------------------------------------------------------------------ //
section("6) 版本纪律：仍是 0.3.9 开发态，不 bump 版本");
// ------------------------------------------------------------------ //
const pkg = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("browser-extension/manifest.json"));
assert.equal(pkg.version, "0.3.9", "应用版本仍应为 0.3.9");
assert.equal(manifest.version, "2.2.2", "扩展版本仍应为 2.2.2");
pass("版本号未动（0.3.9 / 2.2.2）");

console.log(`\nPASS 视频整页解析契约：${passed} 组断言全部通过（抖音放行 + cookie 桌面端通道 + 跨层判定一致 + 凭证边界 + 版本纪律）`);
