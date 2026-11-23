# FluxDL · 迅流下载器

一个 Windows 桌面下载器：普通文件直链由 Rust 引擎分段下载，视频网页由 yt-dlp 解析，浏览器扩展可接管下载并识别页面里的媒体资源。

> **最新正式版 `v0.4.1`**（北京时间 2026-11-23 发布） · 浏览器扩展 `v2.2.2` · 官方成品为 **Windows 10/11 x64**
> 仓库：<https://github.com/Supenman/FluxDL> · 下载：[Releases](https://github.com/Supenman/FluxDL/releases)

---

## dev 开发进度

v0.4.1 是修复版：HTTP 续传改用强 `ETag` 校验、任务记录逐条容错并加 `.bak` 备份、新增按类型归档下载、任务快照提速，同时补齐 GitHub Actions 检查与发版校验脚本。详见[版本历史](#版本历史)。

---

## 目录

- [当前版本能做什么](#当前版本能做什么)
- [能力边界与已知限制](#能力边界与已知限制)
- [最快上手：直接用成品包](#最快上手直接用成品包)
- [两条下载通道如何自动分流](#两条下载通道如何自动分流)
- [架构与目录结构](#架构与目录结构)
- [从源码构建](#从源码构建)
- [浏览器扩展](#浏览器扩展)
- [本地捕获服务协议](#本地捕获服务协议)
- [自更新与版本管理](#自更新与版本管理)
- [发布前检查](#发布前检查)
- [测试](#测试)
- [安全说明](#安全说明)
- [版本历史](#版本历史)
- [相关文档](#相关文档)

---

## 当前版本能做什么

本节描述 **v0.4.1 正式版**。v0.4.0 带来的紧凑任务视图、独立进度窗口和主题预设继续保留；v0.4.1 另修复了续传一致性与任务记录损坏两个隐蔽缺陷。[完整发布说明](https://github.com/Supenman/FluxDL/releases/tag/v0.4.1)

### 下载引擎（A 档 · 普通 HTTP / 文件直链）

| 能力 | 说明 |
|---|---|
| 多连接分段 | 自动模式按文件大小选取连接数，慢分段可由其他连接分担 |
| 断点续传 | `.fluxdl-part` 临时文件 + `tasks.json` 进度持久化；续传前校验 part 真实长度、服务器强 `ETag` 与总长度三者一致，源站内容变更即整体重下，杜绝「长度对但内容坏」 |
| 任务队列 | 最大并发数、暂停 / 继续 / 删除、终态释放路径占位 |
| 任务记录容错 | `tasks.json` 逐条解析，单条损坏只跳过该条；另写 `.bak` 备份，主文件不可读时自动回退并在界面提示 |
| 按类型归档 | 设置中可开启，新任务自动归入 `视频` / `文档` / `压缩包` / `其他` 子文件夹；默认关闭 |
| 定时下载 | 新建任务时可选择开始时间，应用重启后仍保留定时计划 |
| 限速 | 全局限速与单任务限速**串联生效**；视频任务同样受「设置」里的限速约束 |
| 每任务网络参数 | 代理、User-Agent、Referer 可独立设置（扩展接管的链接自动带浏览器 UA，缓解防盗链 403） |
| 分片写盘校验 | 每个分片写盘时同步算 SHA-256，整任务完成后回读磁盘逐段比对；不一致拒绝生成最终文件，杜绝「大小对但内容坏」 |
| 慢连接换线 | 连接建立后 15 秒内持续低于 12 KB/s 或完全卡住，自动换连接从已下载位置继续；已限速任务不会被误判 |
| 速度显示 | 速度 EMA 平滑、ETA 按平滑速度重算，兼容 yt-dlp 的浮点 / `NA` 速度串；视频与直链两条通道口径一致，不再长时间显示 `—` |
| 其它 | 同路径并发任务各自占位、`tasks.json` 原子写、文件已存在直接复用、媒体任务中间目录 RAII 清理 |

### 视频解析

| 能力 | 说明 |
|---|---|
| yt-dlp 整页解析 | 按 27 个站点的主机名名单自动判定；格式 `bv*+ba/b`，ffmpeg 合并为 mp4，`--concurrent-fragments 4` 做分片间并发 |
| HLS 下载 | 桌面端识别 `.m3u8` 链接并交给 yt-dlp 处理 |
| 抖音单视频免 Cookie 解析 | 粘贴 `www.douyin.com/video/<id>`、`v.douyin.com` 短链或带 `modal_id` 的精选页链接，桌面端用移动端公开详情接口 `api.amemv.com/aweme/v1/aweme/detail/` 取无水印直链，转成普通 HTTP 任务交给 A 档引擎下载。已由 Windows 真机验证通过 |
| 「本页资源」探针 | 扩展在 MAIN world hook `fetch` / `XHR` / `Blob`，并补扫 performance 条目、`<video>/<audio>/<source>` 与页面内联脚本，抓出藏在 JSON 响应里的 mp4 直链 |
| 资源列表 | 搜索、按类型筛选、排序（最新 / 体积 / 名称）、全选、批量下载、复制直链、展开备用地址、探活状态（正常 / 失效 / 未知）、一键刷新校验 |
| 平台结构化正片（兜底） | 按抖音 `aweme/detail`、快手 `INIT_STATE` / graphql、SSR `_ROUTER_DATA` / `RENDER_DATA` 的字段语义挑正片直链，来源标「解析正片」；**见下方边界说明** |
| 无扩展名直链 | `.../play/?mime_type=video_mp4` 这类 CDN 直链一律显式按普通下载发送，不再被误判成整页解析任务而「点了没反应」 |

### 桌面端（Tauri 2 + React 18）

无边框窗口、任务分组、实时速度与进度曲线、命令面板、剪贴板链接监听、托盘、设置页、下载完成打开文件所在目录。

### 浏览器扩展（MV3，v2.2.2）

自动接管 `http(s)` 下载链接、右键「用 FluxDL 下载此链接 / 此媒体」、按标签页缓存资源、弹窗单条或全部发送。**manifest 不含 `cookies` 权限，不读取、不传输、不保存任何登录凭证。**

### 自更新

设置页「版本与更新」：启动后静默检查、手动强制检查、增量更新（只下载约 10 MB 的 `fluxdl.exe`）、SHA-256 强制校验、升级失败自动回滚，以及历史版本管理。

### 内置工具

成品包自带 `yt-dlp.exe`、`ffmpeg.exe`、`aria2c.exe`，无需另行安装；`yt-dlp` 支持后台静默自动更新（24h 冷却、失败静默、官方源失败回退镜像），设置页可关。

---

## 能力边界与已知限制

> 这一节和上一节同等重要：**明确写出当前做不到的事**，避免把「在站点名单里」误当成「一定能下载」。

| 项 | 状态 | 说明 |
|---|---|---|
| 浏览器 Cookie / 登录态 | ❌ **完全不读取** | 自 v0.3.0 起的隐私红线：不读取、不传输、不落盘任何 Cookie / token / Authorization。旧的「yt-dlp + 本机浏览器 Cookie」方案已真机证伪并整体删除，设置页不再有 Cookie 配置项 |
| 快手整页解析 | ❌ 不支持 | 随包 yt-dlp 没有 Kuaishou / Kwai 提取器，整页链接会在建任务时拦截并给出指引；请改用「本页资源」里嗅探到的视频直链 |
| 抖音图集 / 实况 Live Photo / 已删除·私密·被风控作品 | ❌ 不支持 | 解析会给出可操作提示，请改用「本页资源」直链 |
| 抖音主页批量、站点首页 / 发现页 / 精选页 | ❌ 不支持 | 无具体视频 id 的聚合页在建任务时拦截 |
| 需登录才能观看的站点内容 | ⚠️ 通常失败 | YouTube 等站点仍在主机名名单内，但零凭证策略下不会携带登录态，遇到风控 / 需登录视频会解析失败；这类页面请用「本页资源」直链 |
| **B 站等 yt-dlp 通道的速度** | ⚠️ **已知较慢** | 视频网页走 yt-dlp 原生下载，匿名 CDN 常对单条连接限速到几百 KB/s。`--concurrent-fragments` 由 4 提到 8 的实测**无效**，瓶颈是「单连接被限」而非「分片数不够」。经 0.3.6 → 0.3.9 逐版本比对，代码与随包 `yt-dlp.exe` 完全一致，属站点侧策略变化而非 FluxDL 版本回归。详见 [B 站下载慢根因定位](./docs/B站下载慢-根因定位与修复建议.md) |
| 抖音 `api.amemv.com` 接口 | ⚠️ 非官方 | 站点未公开接口而非官方 API，随时可能变更；直链带时效签名与 `Referer` 防盗链，解析后应尽快下载，不长期缓存 |
| 扩展「解析正片」 | ⚠️ 仅兜底 | 真机未稳定出现该条目（多数新版页面不把详情渲染在明文 JSON / 内联脚本里）。抖音主路径是桌面端免 Cookie 解析，不依赖它 |
| 不承诺 | — | 不承诺不限速、不承诺 100% 解析成功；失败时请用「本页资源」里嗅探到的视频直链做普通下载 |
| 平台 | ⚠️ 仅 Windows | 官方只发布 Windows x64 成品；源码可跨平台构建，Linux 构建说明仅作开发者参考 |
| 运行环境 | — | 需要 WebView2 Runtime（一般系统自带） |

---

## 最快上手：直接用成品包

[v0.4.1 Release](https://github.com/Supenman/FluxDL/releases/tag/v0.4.1) 提供以下文件。

| 包 | 说明 |
|---|---|
| `FluxDL-0.4.1-Setup.exe` | NSIS 安装版，单用户安装、不需要管理员权限 |
| `fluxdl.exe` | 裸主程序（约 9.7 MB），**应用自更新只下载它** |
| `SHA256SUMS.txt` / `update-manifest.json` | 校验清单和自更新清单 |

安装包自带 `browser-extension/` 与 `tools/`。

**装完只做一件事**：Chrome / Edge 打开 `chrome://extensions` → 开启「开发者模式」 → 「加载已解压的扩展程序」 → 选包里的 `browser-extension` 文件夹。**每次升级扩展后必须重新加载一次并刷新目标网页**，否则浏览器仍运行旧版探针。

抖音下载：`复制详情页 / 短链 → 桌面端「新建任务」粘贴`，自动免 Cookie 解析下载。
B 站等站点：在页面点「解析并下载本页视频」。
快手 / 聚合页 / 解析失败：在扩展弹窗「本页资源」里点选视频直链。

---

## 两条下载通道如何自动分流

无需手工切换，按链接形态自动判定：

```
普通整文件直链（.zip/.exe/.mp4 等、CDN 视频直链、抖音解析出的直链）
        └─► TaskKind::Http ─► Rust HTTP 引擎
                             （分段下载 / SHA-256 回读 / 慢连接换线 / 断点续传）

视频网页（B 站等站点）或桌面端识别的 HLS 清单
        └─► TaskKind::Media ─► yt-dlp 原生下载 ─► ffmpeg 合并 mp4
                               （--concurrent-fragments 4）

抖音作品页（TaskKind::Media）
        └─► douyin.rs 免 Cookie 解析 ─► 转 TaskKind::Http ─► 回到 A 档引擎
```

**为什么视频不走 aria2**：DASH / HLS 单片约 100 KB，小于 aria2 的 `-k4M` 切分阈值，不会切分、恒用 1 条连接（`CN:1`）还额外起进程，反而更慢。自 v0.3.4 起所有 `TaskKind::Media` 默认关闭 aria2；**B 站还被 `aria2_suits_url()` 显式排除**。

`kind:"http"` 显式优先于站点名单兜底；CDN 直链即使带站点域名也按普通下载处理（v0.3.5 起）。

---

## 架构与目录结构

```
浏览器扩展 (MV3)  ──HTTP──►  127.0.0.1:35917  ──►  Tauri 命令层  ──►  download-engine (Rust)
   background.js              本地捕获服务            src-tauri/src/lib.rs      多段下载 / 持久化
   page-probe.js (MAIN world)                        React 18 前端 UI
   probe-bridge.js / popup.*
```

| 层 | 技术 | 位置 |
|---|---|---|
| 前端 | React 18 + TypeScript + Vite + Zustand | `src/` |
| 桌面壳 | Tauri 2 / Rust | `src-tauri/` |
| 下载引擎 | Rust crate `fluxdl-engine` | `crates/download-engine/` |
| 浏览器扩展 | Chrome Extension Manifest V3 | `browser-extension/` |
| 内置工具 | yt-dlp / ffmpeg / aria2c 二进制 | `tools/`（**不进 Git**，由成品包注入） |

关键文件：

```
crates/download-engine/src/
├── http.rs        # A 档分段下载、SHA-256 回读、StallWatch 慢连接换线
├── manager.rs     # 队列、任务类型判定、抖音 Media→Http 转换、路径占位、持久化
├── media.rs       # yt-dlp / ffmpeg 调用、media_page_blocker、站点名单
├── douyin.rs      # 抖音免 Cookie 直链解析
├── aria2.rs       # aria2 参数与 URL 适配（B 站硬排除）
├── ytdlp.rs       # yt-dlp 后台自动更新
├── util.rs        # SpeedSample / EMA 平滑 / SegmentDigest / 文件名清理
├── store.rs       # tasks.json 原子写入
├── limit.rs       # 限速器
└── types.rs       # EngineOptions / TaskKind
browser-extension/ # background.js、page-probe.js、probe-bridge.js、popup.*
scripts/           # 6 个契约脚本（速度 / 媒体解析 / 扩展 / 引擎可靠性 / 探针 / 平台解析）
docs/              # 开发进度、版本管理
```

---

## 从源码构建

### 环境

| 平台 | 依赖 |
|---|---|
| 通用 | Rust stable、Node.js 18+、pnpm/npm |
| Windows | MSVC Build Tools、WebView2 Runtime |
| Linux（仅源码构建参考） | `libwebkit2gtk-4.1-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev`、`patchelf`、`pkg-config`、`build-essential` |

### 开发模式

```bash
git clone https://github.com/Supenman/FluxDL.git
cd FluxDL
npm ci
cd tools && ./fetch-tools.sh && cd ..   # 可选：取 yt-dlp / ffmpeg / aria2c
npm run tauri dev
```

只调前端 UI 时可 `npm run dev` 后打开 `http://localhost:1420`；`src/lib/backend.ts` 在非 Tauri 环境会切到 `MockBackend`，界面可预览但**不会真正下载**。

### 生产构建

```bash
cd FluxDL
cd tools && ./fetch-tools.sh && cd ..   # 必须，否则成品包不带视频解析能力
npm run tauri build
```

Windows 交叉编译本项目的实际命令（发布 v0.3.9 时使用）：

```bash
cd src-tauri
cargo xwin build --release --target x86_64-pc-windows-msvc
```

> **注意**：根目录 workspace 只含 engine，Tauri app 是独立 workspace；**必须在 `src-tauri/` 内编译**，否则 `fluxdl.exe` 不会更新。二进制内嵌版本号可用 `strings` 抽查。

`csp` 当前为 `null`，公开发布前建议收紧并复核扩展的 `host_permissions`。

---

## 浏览器扩展

`browser-extension/manifest.json` 关键权限：

```json
"permissions": ["contextMenus", "downloads", "storage", "notifications", "webRequest", "tabs"],
"host_permissions": ["<all_urls>", "http://127.0.0.1:35917/*", "http://localhost:35917/*"]
```

- **没有 `cookies` 权限**，description 明确「不读取、不传输任何登录凭证」。
- `background.js` 是 MV3 service worker，状态存 `chrome.storage.session`（按 `tabId`），空闲可被回收。
- `page-probe.js` 以 `world: "MAIN"`、`run_at: "document_start"` 注入，只读取 URL 字符串，不接触凭证。
- 资源写入用 Promise 链串行化，避免多个响应同时返回时 `read → await → write` 互相覆盖。
- 契约脚本 `check_extension_contract.cjs` / `check_probe_contract.cjs` / `check_platform_parse_contract.cjs` 锁定 `payload=userAgent`、站点名单一致性与「本页资源显式 `kind:"http"`」等跨层约定。

---

## 本地捕获服务协议

桌面端启动即在 `127.0.0.1:35917` 监听，**不需要独立服务器、不需要云部署**。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 健康检查 |
| `/api/downloads` | POST | 添加下载任务 |

公共请求头：`x-fluxdl-token: fluxdl-local-v1`。

```jsonc
// POST /api/downloads
{
  "url": "https://example.com/file.zip",
  "filename": "file.zip",       // 可选
  "referer": "https://...",     // 可选
  "userAgent": "...",           // 可选；兼容旧拼写 user_agent
  "kind": "http"                // 可选：http | media；缺省按 URL 自动判断
}
```

> v0.3.9 起请求体**没有 `cookies` 字段**，桌面端也不接受任何凭证。

**准入规则**（`capture_guard.rs`，在 OPTIONS / health / token 校验之前执行）：

1. `Host` 必须是 `127.0.0.1` 或 `localhost` + 约定端口 —— 防 DNS rebinding；
2. `Origin` 必须为空、`chrome-extension://…` 或 `moz-extension://…`；网页来源、`null`、`file` 一律 403 且**不返回** `Access-Control-Allow-Origin`。

令牌写在扩展源码里属于公开值，单靠它挡不住网页；浏览器跨域请求必定带 `Origin` 且 JS 无法伪造，所以用 Host + Origin 兜底。

---

## 自更新与版本管理

| 能力 | 说明 |
|---|---|
| 查看版本 | 应用版本 / 引擎版本 / 运行平台 / 安装版或便携版 |
| 检查更新 | 启动后静默检查；设置页可强制检查 |
| 增量更新 | 只下载变化的 `fluxdl.exe`（约 10 MB），不重下安装包 / ffmpeg |
| 更新历史 | 版本号 / 发布时间 / 通道 / 逐条说明 |
| 失败回滚 | 替换前备份 `.bak`，启动时校验 sha256，不符自动回滚；连续两次启动失败回退上一版本 |
| 版本库 | `%LOCALAPPDATA%\com.fluxdl.desktop\app-versions\<版本>\fluxdl.exe`，更新失败可据此回退 |

版本号遵循语义化版本；`update-manifest.json` 是「应用本体 / 工具 / 历史」三合一结构（`schema` / `app` / `tools` / `history`）。`sha256` 是强制的：清单里缺失则该更新直接拒绝（fail-closed）。清单由 `tools/build-update-manifest.py` 生成。

正式发布时使用发布产物目录中的更新清单。开发分支的清单可保留旧版本，直到下一次正式发布。

---

## 发布前检查

用 Python 3.11 或更新版本运行。先将 Windows 安装包、`fluxdl.exe`、用 `tools/build-update-manifest.py` 生成的 `update-manifest.json` 和 `SHA256SUMS.txt` 放在同一个发布产物目录。校验清单使用 `sha256sum` 的格式，记录这三个待上传文件的哈希值。

```sh
python tools/check-release.py --tag v0.4.1 --artifacts path/to/release
```

将示例标签替换为准备发布的版本。检查核对源码的三个应用版本字段、产物清单版本、预期的 GitHub 下载地址、更新包大小和每个产物的 SHA-256。上传之后，在 Release 页面确认下载链接可用。

---

## 测试

```bash
cargo test --locked -p fluxdl-engine   # Linux 跑完整套件
npm run build                          # tsc --noEmit + vite
for script in browser-extension/*.js; do node --check "$script" || exit 1; done
node scripts/check_speed_contract.cjs
node scripts/check_media_parse_contract.cjs
node scripts/check_extension_contract.cjs
node scripts/check_probe_contract.cjs
node scripts/check_platform_parse_contract.cjs
node scripts/check_engine_reliability_contract.cjs
```

GitHub Actions 在 `dev`、`main` 推送和 PR 时运行：Linux 跑完整引擎套件，Windows 跑 HTTP、持久化和分段再平衡测试，前端跑构建及六个契约检查。

---

## 安全说明

| 项 | 现状 | 建议 |
|---|---|---|
| 凭证红线 | **不读取、不传输、不落盘任何 Cookie / 登录态**；扩展无 `cookies` 权限 | 保持不变 |
| 本地令牌 | `fluxdl-local-v1` 是写死在扩展里的公开常量 | 改为运行时随机令牌 + 扩展配对 |
| CSP | `csp: null` | 公开发布前收紧 |
| 扩展权限 | `host_permissions: <all_urls>`（资源嗅探需要） | 评估是否收窄到具体站点 |
| 下载目标 | `engine.add()` 只接受 `http` / `https`，响应只落本地文件 | 多用户机器注意本机发起内网探测的可能 |
| `dist/` / `tools/` 二进制 | 前端产物与工具二进制不进 Git | 二进制统一走 Releases |

---

## 版本历史

| 版本 | 日期 | 要点 |
|---|---|---|
| **0.4.1** | 2026-11-23 | 修复版。续传改强 `ETag` + `If-Range` 校验，源站内容变更不再复用旧字节；`tasks.json` 逐条容错解析并增加 `.bak` 备份自动回退、恢复时界面提示；服务器泛化文件名不再顶掉已有有意义文件名；新增按类型归档下载（默认关闭）；任务快照读取提速；任务行去掉重复的重试图标；新增 CI 工作流与 `tools/check-release.py` 发版校验 |
| 0.4.0 | 2026-11-18 | 自适应连接数、慢分段再平衡、定时下载、HLS 支持、紧凑任务视图及独立进度窗口 |
| 0.3.9 | 2026-11-09 | 修复视频速度恒显示 `—`；抖音改走免 Cookie 移动端接口并真机通过；删除 yt-dlp + Cookie 通道；「本页资源」做扎实（显式 `kind:"http"`、搜索/筛选/批量/探活）；平台结构化正片；A 档分片 SHA-256 回读校验与慢连接换线；正式发版、合并 `main`、建 Release |
| 0.3.8 | 2026-11-07 | 速度与曲线 EMA 平滑根治锯齿；视频/直链速度来源分离；ETA 自洽 |
| 0.3.7 | 2026-11-07 | 仓库由 FuxDL 改名 FluxDL 后同步遗留地址；扩展合入 MAIN world 探针（2.2.1） |
| 0.3.6 | 2026-11-07 | 抖快整页链接提前拦截并给直链指引；主按钮改「下载本页视频（直链）」；噪声过滤；中间目录 RAII 清理 |
| 0.3.5 | 2026-11-07 | 删除与解析器能力不符的「支持站点」名单；CDN 视频直链按普通直链下载；如实说明能力边界 |
| 0.3.4 | 2026-11-06 | 统一 27 站点名单；`Media` 一律关闭 aria2（`CN:1` 问题）；修复 UA 字段契约、乱码标题误杀、旧数据任务列表消失 |
| 0.3.3 | 2026-11-06 | 修复 B 站恒单连接；过滤 aria2 汇总行；乱码标题不再回填 |
| 0.3.2 / 0.3.1 | 2026-11-06 | 修「下载完成但未找到输出」误报；工具探测向上查找；移除 `--concurrent-fragments 1` 性能回归 |
| 0.3.0 | 2026-11-06 | 主程序版本管理与一键增量更新；视频下载失败立即报错；**不再读取/传输/落盘任何 cookie** |
| 0.2.0 及更早 | 2026-11-05~06 | 版本管理、yt-dlp 自动更新、格式降级、扩展 v2 资源嗅探、登录态链路（**该链路已于 0.3.0 移除**）、文件完整性修复 |

完整逐条说明见 `update-manifest.json` 的 `history` 字段与各版 `修复说明-*.md`。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| `使用说明.txt` | 面向用户的完整使用说明（成品包内亦含，交付目录 `/workspace/fluxdl-dist/`） |
| `修复说明-v0.3.9.md` | v0.3.9 逐项修复与验证记录 |
| `docs/功能清单-v0.3.9.md` | v0.3.9 功能与能力边界的历史清单 |
| `docs/开发进度.md` | 跨会话进度、待办、已知风险 |
| `docs/版本管理.md` | 版本号规则、增量更新边界、回滚机制 |
| `docs/B站下载慢-根因定位与修复建议.md` | B 站单连接限速的版本比对与方案评估 |
| `tools/README.md` | 内置工具来源、体积与获取方式 |

---

## 许可与免责

本项目仅供个人学习与技术研究使用。通过本项目下载的内容，其著作权及相关权益归原平台与权利人所有；使用者应自行确保已获得必要授权，并在合法合规范围内使用。项目不提供、不绕过任何平台的登录凭证或反爬签名，不承诺对任何站点的解析成功率。

参考项目 `jiuhunwl/short_videos`（MIT）仅用于确认抖音移动端详情接口的字段形态，FluxDL 的 `douyin.rs` 为独立实现，未复制其代码。
