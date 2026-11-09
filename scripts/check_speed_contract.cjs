/**
 * 0.3.8 速度/进度显示一致性契约。
 *
 * 背景：速度锯齿有两个引擎侧根因 + 一个前端根因：
 *  1) tick() 每 500ms 用纯瞬时 Δbytes/dt 覆盖 view.speed_bps，无平滑；
 *  2) Media 任务的 speed_bps 被「进度行」和「tick 差分」两个写入者交替覆盖；
 *  3) 前端 SpeedChart 拿窗口内最大值当纵轴量程，尖峰进出把整条曲线反复压平/拉高。
 *
 * 本脚本做两类验证：
 *  · 静态：确认三处职责分工与 EMA 接入都真实落在源码里（而非只在注释里）；
 *  · 动态：用 esbuild 把真实 format.ts 编译后加载，实测 nextChartScale 的数值行为。
 *
 * 运行：node scripts/check_speed_contract.cjs
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const esbuild = require("esbuild");

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
const managerSrc = read("crates/download-engine/src/manager.rs");
const mediaSrc = read("crates/download-engine/src/media.rs");
const formatSrc = read("src/lib/format.ts");
const chartSrc = read("src/components/SpeedChart.tsx");

// ------------------------------------------------------------------ //
section("1) 引擎：EMA 平滑纯函数存在且公式正确");
// ------------------------------------------------------------------ //
assert.match(utilSrc, /pub fn smooth_speed\(prev: u64, instant: u64\) -> u64/, "util.rs 缺少 smooth_speed");
assert.match(utilSrc, /prev as u128 \* 7 \+ instant as u128 \* 3/, "EMA 需保留 0.3 新样本权重");
assert.match(utilSrc, /if prev == 0 \{\s*return instant;/, "起步需即时跟随，避免速度从 0 缓慢爬升");
assert.match(utilSrc, /instant == 0/, "真实 0 字节周期需能衰减");
pass("smooth_speed：起步即时、EMA 削峰、0 值衰减、u128 防溢出");

// ------------------------------------------------------------------ //
section("2) 引擎：tick() 按任务类型分工，消除双写");
// ------------------------------------------------------------------ //
assert.match(managerSrc, /let is_media = entry\.kind == TaskKind::Media;/, "tick() 需按 kind 区分写入者");
assert.match(managerSrc, /if !is_media \{\s*view\.speed_bps = speed;/, "HTTP 分支才写 speed_bps");
// Media 的速度只能来自 media.rs 的进度行，manager.rs 的 active 分支不得再无条件写。
const tickBody = managerSrc.slice(managerSrc.indexOf("async fn tick(&self)"));
assert.ok(tickBody.length > 0, "未找到 tick()");
assert.match(tickBody, /if !is_media \{/, "tick() 的 speed_bps 写入必须被 !is_media 守护");
assert.match(tickBody, /sample\.speed = util::smooth_speed\(sample\.speed, instant\);/, "HTTP 差分需过 EMA");
// 恢复清零在 resume() 里，不在 tick() 内，按全文断言。
assert.match(managerSrc, /s\.at = None;\s*s\.speed = 0;/, "恢复路径需清空采样时刻与平滑状态");
pass("tick()：Media 由进度行独占、HTTP 走差分+EMA、恢复清零");

// ------------------------------------------------------------------ //
section("3) 引擎：Media 进度行独占写入、浮点速度可解析、未知帧兜底");
// ------------------------------------------------------------------ //
// 0.3.9 修复：yt-dlp 的 progress.speed 在分片/合并阶段常是浮点串（如
// `1234567.89`）或 NA/None/空。0.3.8 用 parts[3].parse::<i64>() 解析，浮点
// 串与 NA 全部失败 → -1 → 速度恒 0 → 前端显示 `—`，而 ETA 走 f64 解析仍显示
// 剩余时间，出现「有剩余时间却没速度」。新架构用 SpeedSample 状态机：浮点
// 优先、NA 时字节差分兜底、未知帧保留上次平滑值绝不写 0。
assert.match(mediaSrc, /let mut speed_sample = util::SpeedSample::default\(\);/, "media::run 缺少 SpeedSample 状态");
assert.match(mediaSrc, /speed_sample\.advance\(started\.elapsed\(\)\.as_secs_f64\(\), downloaded, parts\[3\]\);/, "进度行需推进 SpeedSample");
assert.match(mediaSrc, /let smoothed_speed = speed_sample\.speed;/, "发布值来自 SpeedSample");
assert.match(mediaSrc, /view\.speed_bps = smoothed_speed;/, "Media 需发布平滑速度");
assert.ok(!/view\.speed_bps = raw_speed/.test(mediaSrc), "不得再把瞬时 raw_speed 直接写进 view");
// 关键反回归：进度行速度字段不得再用 i64 解析（浮点串会失败）。
// 先剔除行注释，避免匹配到解释旧实现的注释本身。
const mediaNoComments = mediaSrc.replace(/\/\/.*$/gm, "");
assert.ok(!/parts\[3\]\.parse::<i64>\(\)/.test(mediaNoComments), "0.3.8 根因：parts[3] 不得用 i64 解析（浮点/NA 全失败）");
// 浮点解析与差分兜底必须存在于 util 纯函数里。
assert.match(utilSrc, /pub fn progress_speed\(/, "util.rs 缺少 progress_speed 浮动解析 + 差分兜底");
assert.match(utilSrc, /speed_field\.trim\(\)\.parse::<f64>\(\)/, "progress_speed 需优先接受浮点速度串");
assert.match(utilSrc, /SPEED_DELTA_MIN_SECS/, "差分兜底需有 dt 下限，避免进度行过密放大成尖峰");
assert.match(utilSrc, /pub struct SpeedSample/, "util.rs 缺少 SpeedSample 状态机");
assert.match(utilSrc, /unknown 帧保留上一次平滑速度|未知帧保留上一次平滑速度|绝不写 0|绝不发布 0/, "SpeedSample 需保证未知帧不写 0（修复 `—`）");
pass("media::run：SpeedSample 浮点解析 + 差分兜底 + 未知帧保留，不再与 tick 抢写");

// ------------------------------------------------------------------ //
section("4) 前端：量程纯函数接入 SpeedChart");
// ------------------------------------------------------------------ //
assert.match(formatSrc, /export function nextChartScale/, "format.ts 缺少 nextChartScale");
assert.match(chartSrc, /nextChartScale\(prev\.scale, windowed\)/, "SpeedChart 未使用稳定的量程");
assert.match(chartSrc, /scale: nextChartScale/, "量程需与采样点在同一 state 帧推进");
assert.ok(!/Math\.max\(1, \.\.\.samples\)/.test(chartSrc), "不得再用窗口峰值直接当量程序");
assert.match(chartSrc, /const \{ samples, scale: max \} = chart;/, "max 需来自持久化量程");
pass("SpeedChart：峰值即时跟随、回落缓慢，曲线不再整体缩放");

// ------------------------------------------------------------------ //
section("5) 动态：用 esbuild 加载真实 format.ts 实测 nextChartScale");
// ------------------------------------------------------------------ //
const compiled = esbuild.transformSync(formatSrc, { loader: "ts", format: "cjs" }).code;
const moduleObj = { exports: {} };
new Function("module", "exports", compiled)(moduleObj, moduleObj.exports);
const { nextChartScale } = moduleObj.exports;
assert.strictEqual(typeof nextChartScale, "function", "nextChartScale 未被导出为函数");

// 峰值即时跟随：新尖峰出现时量程立刻抬到峰值，曲线不会顶出画布。
assert.strictEqual(nextChartScale(1, [10, 20, 30]), 30, "峰值需即时跟随");
// 峰值滑出窗口后缓慢回落，而不是骤降到窗口峰值（旧行为的锯齿根源）。
const afterSpike = nextChartScale(1000, [30, 25, 20]);
assert.strictEqual(afterSpike, 850, "峰值滑出后按 0.85 缓慢回落，不骤降");
// 量程始终 >= 1 且不低于当前窗口真实峰值。
assert.strictEqual(nextChartScale(0, []), 1, "空窗口量程下限为 1");
assert.ok(nextChartScale(50, [900]) >= 900, "量程不得低于窗口真实峰值");
assert.ok(Number.isFinite(nextChartScale(1e9, [0])), "量程必须是有限数");
// 连续回落是单调、有界、逐步逼近的：给一个恒定低速窗口，量程不会忽大忽小。
// 回落系数 0.85，从 1000 逼近 100 需 log(0.1)/log(0.85)≈15 帧，故取 16 帧。
let scale = 1000;
const seq = [];
for (let i = 0; i < 16; i += 1) {
  scale = nextChartScale(scale, [40, 38, 42]);
  seq.push(scale);
}
for (let i = 1; i < seq.length; i += 1) {
  assert.ok(seq[i] <= seq[i - 1] + 1e-9, "无新尖峰时量程不得反弹");
}
assert.ok(seq[seq.length - 1] >= 42, "回落不得低于窗口峰值");
assert.ok(seq[seq.length - 1] < 100, "持续低速后量程应逼近窗口峰值");
pass("nextChartScale 实跑：即时抬升 / 缓慢回落 / 下限与单调性");

// ------------------------------------------------------------------ //
section("6) 引擎：两条通道 ETA 与平滑速度同口径");
// ------------------------------------------------------------------ //
// 速度已平滑但 ETA 仍取解析器原始值，会让「速度」与「剩余时间」互相打架，
// 且解析器 ETA 随分片切换跳字。两条通道必须共用 eta_from_speed 重算。
assert.match(utilSrc, /pub fn eta_from_speed\(/, "util.rs 缺少 eta_from_speed 纯函数");
assert.match(utilSrc, /total > downloaded && speed > 0/, "ETA 仅在总量有效且平滑速度 >0 时重算");
assert.match(mediaSrc, /let parsed_eta = parts\[4\]/, "解析器原始 ETA 应降级为 fallback");
assert.match(
  mediaSrc,
  /let eta = util::eta_from_speed\(total, downloaded, smoothed_speed, parsed_eta\);/,
  "Media 进度行 ETA 需由平滑速度重算、原始值仅作兜底",
);
assert.match(
  managerSrc,
  /view\.eta_seconds = util::eta_from_speed\(view\.total_bytes, bytes, speed, None\);/,
  "HTTP 差分 ETA 需复用同一函数，保证两条通道口径一致",
);
assert.ok(
  !/view\.eta_seconds = parts\[4\]/.test(mediaSrc),
  "不得再把解析器原始 ETA 直接写进 view",
);
pass("ETA：Media / HTTP 统一由平滑速度重算，口径一致、跳字收敛");

console.log(`\n速度一致性契约全部通过（${passed} 组断言）。`);
