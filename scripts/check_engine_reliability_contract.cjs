/**
 * 0.3.9 开发态 A 档增强：下载引擎可靠性契约（分片写后回读校验 + 慢连接抢占换线）。
 *
 * 背景：分段下载把响应体经 write_at 写到稀疏 .part 文件的绝对偏移。仅凭
 * `downloaded == total` 发现不了「大小正确但内容损坏」（稀疏空洞、越界覆盖、
 * 写未落盘）——0.3.9 的 P0-2 是同类问题的一种。同时连接建立后若只滴几 KB/s
 * 乃至完全卡住却不断流，原来的 30s 只覆盖请求头，会一直拖到整体超时。
 *
 * 本脚本做源码级断言，锁定两项能力真的接进热路径（而非只写在注释里）；
 * 数值行为由 `cargo test -p fluxdl-engine --lib` 的 Rust 单测覆盖。
 *
 * 运行：node scripts/check_engine_reliability_contract.cjs
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

const utilSrc = read("crates/download-engine/src/util.rs");
const httpSrc = read("crates/download-engine/src/http.rs");
const cargoSrc = read("crates/download-engine/Cargo.toml");

// ------------------------------------------------------------------ //
section("1) 零新增依赖：sha2 已在引擎依赖里（复用更新包校验那份）");
// ------------------------------------------------------------------ //
assert.match(cargoSrc, /^sha2\s*=\s*"0\.10"/m, "download-engine 必须复用既有 sha2 依赖，不引入新 crate");
assert.match(utilSrc, /use sha2::\{Digest, Sha256\};/, "util.rs 需导入 sha2");
assert.ok(
  !/ring\s*=|openssl\s*=|md-5\s*=|blake3\s*=/.test(cargoSrc),
  "校验不得引入额外的哈希/加密依赖"
);
pass("sha2 复用既有依赖，DigestSink 把 sha2 封在 util 内，http.rs 不直接依赖");

// ------------------------------------------------------------------ //
section("2) util.rs：写后回读校验的原子能力齐全");
// ------------------------------------------------------------------ //
assert.match(utilSrc, /pub fn read_at\(file: &File, buf: &mut \[u8\], offset: u64\)/, "缺少绝对偏移读取 read_at");
assert.match(utilSrc, /pub struct DigestSink/, "缺少增量摘要器 DigestSink");
assert.match(utilSrc, /pub struct SegmentDigest/, "缺少分段摘要记录 SegmentDigest");
assert.match(utilSrc, /pub fn update\(&mut self, bytes: &\[u8\]\)/, "DigestSink 缺少增量 update");
assert.match(utilSrc, /pub fn hash_region\(file: &File, start: u64, len: u64\)/, "缺少区间 SHA-256 hash_region");
assert.match(utilSrc, /pub fn verify_regions\(file: &File, digests: &\[SegmentDigest\]\)/, "缺少逐段回读比对 verify_regions");
assert.match(utilSrc, /got != d\.hash/, "verify_regions 必须在摘要不一致时返回该记录下标");
assert.match(utilSrc, /copy_from_slice\(&out\)/, "摘要落地需显式 copy_from_slice，避免 GenericArray -> [u8;32] 版本差异");
pass("read_at / DigestSink / hash_region / verify_regions 齐全且逐段比对");

// ------------------------------------------------------------------ //
section("3) http.rs：分段与单流都在写盘同时算摘要");
// ------------------------------------------------------------------ //
assert.match(httpSrc, /let mut sink = util::DigestSink::new\(\);/, "segment_loop/sequential_stream 需各自持有 DigestSink");
assert.match(httpSrc, /sink\.update\(&chunk\);/, "每个写入 chunk 必须喂给摘要器");
// 写盘与摘要必须用同一批字节：write_at 之后紧接 update。
const writeThenUpdate = httpSrc.indexOf("util::write_at(&file, &chunk, pos)?;");
const updateAfterWrite = httpSrc.indexOf("sink.update(&chunk);", writeThenUpdate);
assert.ok(writeThenUpdate > 0 && updateAfterWrite > writeThenUpdate, "摘要必须紧跟写盘、作用于同一批字节");
assert.match(httpSrc, /write_at\(file, &chunk, position\)\?;\s*sink\.update\(&chunk\);/, "单流路径也需写盘即算摘要");
pass("分段与单流两条写路径都是「写盘即算摘要」");

// ------------------------------------------------------------------ //
section("4) http.rs：回读校验发生在 rename 之前，失败拒绝落盘");
// ------------------------------------------------------------------ //
assert.match(httpSrc, /async fn finalize_verified\(/, "缺少 finalize_verified");
assert.match(httpSrc, /util::verify_regions\(file, digests\)/, "收尾必须调用逐段回读比对");
assert.match(httpSrc, /finalize_verified\(&entry, &file, &part_path, &save_path, &digests\)/, "分段路径需经 finalize_verified 收尾");
assert.match(httpSrc, /finalize_verified\(&entry, &file, &part_path, &save_path, &\[digest\]\)/, "单流路径需经 finalize_verified 收尾");
// 校验失败分支：删 part、清进度、清分段，且绝不调用 finish_file。
const fvBody = httpSrc.slice(httpSrc.indexOf("async fn finalize_verified("), httpSrc.indexOf("async fn finish_file("));
assert.match(fvBody, /tokio::fs::remove_file\(part\)/, "校验失败必须删除损坏的 part");
assert.match(fvBody, /entry\.downloaded\.store\(0, Ordering::Relaxed\)/, "校验失败必须清零进度，强制全量重下");
assert.match(fvBody, /entry\.segments\.lock\(\)\.clear\(\)/, "校验失败必须清空分段状态");
assert.match(fvBody, /阻止保存损坏文件/, "错误信息必须明确「阻止保存损坏文件」");
// 成功分支才 rename：finish_file 只在 verdict == Ok(None) 分支调用。
assert.match(fvBody, /Ok\(None\) => None/, "仅校验全部一致时 problem 为 None");
assert.match(fvBody, /return finish_file\(part, final_path\)\.await;/, "只有校验通过才落最终文件");
pass("回读校验在 rename 前；不一致时删 part + 清进度/分段，绝不产出损坏成品");

// ------------------------------------------------------------------ //
section("5) util.rs：慢连接状态机常量与判定齐全");
// ------------------------------------------------------------------ //
assert.match(utilSrc, /pub const STALL_WINDOW_SECS: f64 = 15\.0;/, "慢连接判定窗口需为 15s");
assert.match(utilSrc, /pub const STALL_MIN_BPS: f64 = 12\.0 \* 1024\.0;/, "慢连接阈值需为 12KB/s");
assert.match(utilSrc, /pub const STALL_GRACE_SECS/, "需有连接热身期，避免刚连上被误判");
assert.match(utilSrc, /pub const STALL_MAX_SWAPS/, "换线次数需有上限，防止无限重连");
assert.match(utilSrc, /pub struct StallWatch/, "缺少慢连接状态机 StallWatch");
assert.match(utilSrc, /pub fn on_reconnect\(&mut self, now: f64\)/, "换线后需重置热身/窗口");
assert.match(utilSrc, /self\.swaps < STALL_MAX_SWAPS/, "换线必须受次数上限约束");
assert.match(utilSrc, /rate < STALL_MIN_BPS/, "低于阈值才判定慢连接");
pass("StallWatch：15s 窗口 / 12KB/s 阈值 / 热身 / 换线上限齐全");

// ------------------------------------------------------------------ //
section("6) http.rs：慢连接接入热路径，且限速任务不误判");
// ------------------------------------------------------------------ //
assert.match(
  httpSrc,
  /let stall_enabled = entry\.limiter\.limit\(\)\.is_none\(\) && global\.limit\(\)\.is_none\(\);/,
  "任务级或全局限速开启时必须关闭慢连接判定，避免把人为低速误判成慢线路"
);
assert.match(httpSrc, /let mut watch = util::StallWatch::new\(/, "segment_loop 需持有 StallWatch");
assert.match(httpSrc, /tokio::time::interval\(Duration::from_secs\(util::STALL_TICK_SECS\)\)/, "需有心跳以识别零字节死连接");
assert.match(httpSrc, /watch\.observe\(now, 0, remaining, true\)/, "心跳需喂 0 字节观测");
assert.match(httpSrc, /watch\.observe\(now, len, remaining, true\)/, "数据 chunk 需喂实际字节观测");
// 两处 observe 都必须被 stall_enabled 包裹（限速任务不做换线观测）。
const observeCount = (httpSrc.match(/watch\.observe\(/g) || []).length;
const enabledGuardCount = (httpSrc.match(/if stall_enabled \{/g) || []).length;
assert.equal(observeCount, 2, "应恰好有两处慢连接观测（心跳 + 数据）");
assert.ok(enabledGuardCount >= 2, "两处观测都需有 stall_enabled 守卫");
assert.match(httpSrc, /watch\.on_reconnect\(/, "换线后需重置状态机");
assert.match(httpSrc, /engine\.emit_log\(/, "换线需记录任务日志（可观测）");
// 换线不消耗错误重试预算：continue 前不应减小 attempts_left。
const swapBlock = httpSrc.slice(httpSrc.indexOf("if swapped {"), httpSrc.indexOf("if clean_end {"));
assert.match(swapBlock, /continue;/s, "换线需回到循环顶部重发 Range");
assert.ok(!/attempts_left -= 1/.test(swapBlock), "换线不得消耗错误重试预算（它是主动优化而非失败）");
assert.match(
  httpSrc,
  /\.header\(RANGE, format!\("bytes=\{pos\}-\{end\}"\)\)/,
  "换线重连需从已写到的 pos 继续，不丢弃已写字节（Range 起点用当前 pos）"
);
pass("慢连接接入 chunk 循环；换线不丢字节、不耗重试预算、不误判限速任务");

// ------------------------------------------------------------------ //
section("7) 版本纪律：各版本文件一致（不绑死具体号）");
// ------------------------------------------------------------------ //
const pkg = JSON.parse(read("package.json"));
const tauriConf = JSON.parse(read("src-tauri/tauri.conf.json"));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "应用版本格式合法");
assert.equal(tauriConf.version, pkg.version, "tauri.conf.json 与 package.json 版本必须一致");
const manifest = JSON.parse(read("browser-extension/manifest.json"));
assert.equal(manifest.version, "2.2.2", "扩展版本保持 2.2.2");
const cargoVer = cargoSrc.match(/^version = "([^"]+)"/m);
assert.ok(cargoVer, "engine Cargo.toml 缺 version 字段");
assert.equal(cargoVer[1], pkg.version, "engine crate 版本与应用版本必须一致");
pass(`版本号一致（应用 ${pkg.version} / 扩展 2.2.2）`);

console.log(`\n引擎可靠性契约：${passed} 组断言全部通过 ✅\n`);
