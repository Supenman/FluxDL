# FluxDL · 迅流下载器

一个更快、更顺手的桌面下载工具：多线程 HTTP 下载、断点续传、任务队列、限速、视频解析，配合浏览器扩展自动接管网页下载并嗅探页面资源。

> 当前版本 `0.3.0`。项目主体在 [`fluxdl/`](./fluxdl) 目录，仓库根目录只放说明与文档。

---

## 目录

- [功能](#功能)
- [最快上手：直接用成品包](#最快上手直接用成品包)
- [架构与目录结构](#架构与目录结构)
- [从源码构建](#从源码构建)
- [浏览器扩展](#浏览器扩展)
- [版本管理](#版本管理)
- [内置 yt-dlp / ffmpeg](#内置-yt-dlp--ffmpeg)
- [本地捕获服务协议](#本地捕获服务协议)
- [测试](#测试)
- [安全说明与已知限制](#安全说明与已知限制)
- [变更记录](#变更记录)
- [相关文档](#相关文档)

---

## 功能

### 下载引擎（Rust）

| 能力 | 说明 |
|---|---|
| 多段并发 | 按 `Content-Length` 规划分段，多连接并行拉取，按偏移 `seek_write` 落盘 |
| 断点续传 | `.fluxdl-part` 临时文件 + `tasks.json` 进度持久化；**下载前校验 part 文件真实长度**，不一致则重新全量下载，避免补零产生损坏文件 |
| 任务队列 | 最大并发数、暂停 / 继续 / 删除、终态释放路径占位 |
| 限速 | 全局限速与单任务限速**串联生效**，基于「下一时刻表」做长期均值控制，不靠 sleep 抖动 |
| 代理 / UA / Referer | 每个任务可独立设置 |
| 视频下载 | `TaskKind::Media` 调用 `yt-dlp` 解析清晰度，交给 `ffmpeg` 合并音视频；分片并发 4 路，B 站切 `tv,app` 客户端绕开 web 端单连接限速；失败一次即报错，不静默重试 |
| 完整性防护 | 同路径并发任务各自占位、原子替换 `tasks.json`、`spawn_runner` 置位原子化、删除任务同时清理 part |

### 桌面端（Tauri 2 + React 18）

无边框窗口、任务分组、实时速度与进度曲线、命令面板、剪贴板链接监听、设置页、托盘、下载完成打开文件所在目录。

### 浏览器扩展（MV3，v2.2）

- **自动接管所有 `http(s)` 下载**：不设扩展名白名单、不设类型分组、不设最小体积阈值，只有一个总开关。
- **IDM 式资源嗅探**：`webRequest.onResponseStarted` 按 `Content-Type` / `Content-Disposition` / URL 后缀识别音视频与文件，按标签页缓存，弹窗可单条或全部发送到桌面端。
- **视频站点**：`.m4s` / `.m3u8` / `.mpd` 识别为流媒体片段，不刷屏成普通文件；弹窗提示「本页检测到视频」，一键发 `kind: media` 交给桌面端 `yt-dlp` 解析。
- **yt-dlp 自动更新**：FluxDL 把 yt-dlp 冻结打包，但 YouTube 反爬频繁变动、旧版必崩（典型报错 `The page needs to be reloaded`）。后台会静默检查并就地替换随包内置的 yt-dlp（24h 冷却、失败静默、官方源失败回退镜像）；遇到「页面需重载」报错还会强制更新后重试一次。设置页可关闭。
- **不接触登录凭证**：扩展已移除 `cookies` 权限，不读取、不传输任何登录状态；桌面端也没有 cookie 相关参数与临时文件。媒体任务只面向国内站点。
- **右键菜单**：仅「用 FluxDL 下载此链接」「用 FluxDL 下载此媒体」两项。

---

## 最快上手：直接用成品包

不想装 Rust / Node、不想编译的话，直接用构建好的成品包即可。成品包含大体积二进制，不进 Git，统一发布在 [Releases](https://github.com/Supenman/FuxDL/releases)：

| 包 | 平台 | 说明 |
|---|---|---|
| `FluxDL-0.3.0-Setup.exe` | Windows 10/11 x64 | NSIS 安装版，单用户安装、不需要管理员权限 |
| `FluxDL-0.3.0-Windows-便携版.zip` | Windows 10/11 x64 | 解压进 `FluxDL/` 文件夹后双击 `fluxdl.exe`，删文件夹即卸载 |
| `fluxdl.exe` | Windows 10/11 x64 | 单文件（约 9.5 MB），**应用自更新只下载它**，不用重下安装包 |

两个包都**自带** `browser-extension/` 和 `tools/`（Windows 版 yt-dlp + ffmpeg），不用另外安装。

> **官方交付仅 Windows**，不再提供 Linux 成品包。源码仍可跨平台构建，Linux 下的构建说明只作为开发者参考保留。

**装完只做一件事**：Chrome 打开 `chrome://extensions` → 开「开发者模式」 → 「加载已解压的扩展程序」 → 选包里的 `browser-extension` 文件夹（安装版在 `%LOCALAPPDATA%\FluxDL\browser-extension`）。然后随便点个下载链接，FluxDL 窗口冒出任务即通过。

Windows 需要 **WebView2 Runtime**（一般系统自带）。

**装过旧扩展的必须重新加载一次**：v2.2 移除了 `cookies` 权限、改了后台脚本，在 `chrome://extensions` 点扩展的「重新加载」，否则仍在跑旧逻辑。

---

## 架构与目录结构

```
浏览器扩展 (MV3)  ──HTTP──►  127.0.0.1:35917  ──►  Tauri 命令层  ──►  download-engine (Rust)
   background.js              本地捕获服务            src-tauri/src/lib.rs      多段下载 / 持久化
   popup.html/js/css                                  React 18 前端 UI
```

| 层 | 技术 | 位置 |
|---|---|---|
| 前端 | React 18 + TypeScript + Vite 6 + Zustand | `fluxdl/src/` |
| 桌面壳 | Tauri 2 / Rust | `fluxdl/src-tauri/` |
| 下载引擎 | Rust crate `fluxdl-engine` | `fluxdl/crates/download-engine/` |
| 浏览器扩展 | Chrome Extension Manifest V3 | `fluxdl/browser-extension/` |
| 内置工具 | yt-dlp / ffmpeg 静态二进制 | `fluxdl/tools/`（仅成品包，不进 Git） |

关键文件：

```
fluxdl/
├── crates/download-engine/src/
│   ├── http.rs        # 分段下载、probe、续传校验
│   ├── manager.rs     # 队列、路径占位、runner 调度、持久化
│   ├── util.rs        # 文件名清理、段规划、unique_path_reserved
│   ├── store.rs       # tasks.json 原子写入
│   ├── limit.rs       # 限速器
│   ├── media.rs       # yt-dlp / ffmpeg 调用（分片并发、国内站点路由）
│   ├── update.rs      # 更新清单、SHA-256 校验、延迟替换脚本、崩溃恢复
│   ├── ytdlp.rs       # 随包 yt-dlp 后台静默更新
│   └── types.rs       # EngineOptions / TaskKind
├── crates/download-engine/tests/regression.rs   # 9 个回归用例
├── src-tauri/src/
│   ├── lib.rs         # Tauri 命令、本地捕获服务、内置工具探测
│   ├── appversion.rs  # 版本库扫描 / 切换 / boot_guard 启动自检 / prune
│   ├── version.rs     # 检查更新、下载入库、触发替换
│   └── capture_guard.rs  # 请求准入（Host + Origin），可独立 rustc --test
├── browser-extension/  # background.js / manifest.json / popup.*
├── tools/             # README.md + fetch-tools.sh（二进制被 .gitignore 排除）
└── src-tauri/tauri.conf.json   # resources 映射 browser-extension/ 与 tools/
```

---

## 从源码构建

### 环境

| 平台 | 依赖 |
|---|---|
| 通用 | Rust stable、Node.js 18+、pnpm/npm |
| Windows | MSVC Build Tools、WebView2 Runtime |
| Linux（仅源码构建参考，官方不发成品包） | `libwebkit2gtk-4.1-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev`、`patchelf`、`pkg-config`、`build-essential` |

Linux 一键装依赖：

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf pkg-config build-essential
```

### 开发模式（dev）

```bash
git clone https://github.com/Supenman/FuxDL.git
cd FuxDL/fluxdl
npm ci

# 可选：把 yt-dlp / ffmpeg 放进 tools/，启动后会自动识别
cd tools && ./fetch-tools.sh && cd ..

npm run tauri dev      # Vite 1420 + Tauri 窗口，热更新
```

只调前端 UI、不需要 Rust 引擎时，可以 `npm run dev` 后在浏览器打开 `http://localhost:1420`。`src/lib/backend.ts` 检测到非 Tauri 环境会自动切到 `MockBackend`，界面与交互可正常预览，但**不会真正下载**。

### 生产构建（prod）

```bash
cd FuxDL/fluxdl
cd tools && ./fetch-tools.sh && cd ..    # 必须，否则成品包不带视频解析能力
npm run tauri build                      # Windows 产出 NSIS 安装包
```

`tauri.conf.json` 的 `bundle.targets` 目前只有 `nsis`。**官方只发布 Windows 包**，Linux 下如需自行构建可走：

```bash
cd FuxDL/fluxdl/src-tauri
cargo build --release --target x86_64-unknown-linux-gnu
# 把 target/.../release/fluxdl 与 dist/、browser-extension/、tools/ 一起做成便携包
```

> **dev / prod 差异**：dev 下 `bundled_tools_dir()` 额外探测 `CARGO_MANIFEST_DIR/../tools`，方便本地调试；prod 只认安装目录 / exe 旁的 `tools/`。`csp` 当前为 `null`，若后续要发布公开版本，建议在 prod 收紧 CSP 并复核扩展的 `host_permissions`。

---

## 浏览器扩展

`fluxdl/browser-extension/manifest.json` 关键权限：

```json
"permissions": ["contextMenus", "downloads", "storage", "notifications", "webRequest", "tabs"],
"host_permissions": ["<all_urls>", "http://127.0.0.1:35917/*", "http://localhost:35917/*"]
```

- `background.js` 是 MV3 service worker，空闲会被浏览器回收，状态存 `chrome.storage.session`（按 `tabId`），不依赖常驻内存。
- 弹窗通过 `chrome.runtime.sendMessage` 向 service worker 请求 `getPageResources` / `clearPageResources` / `sendDownload`。
- 资源写入使用 Promise 链串行化，避免多个响应同时返回时 `read → await → write` 互相覆盖。

Chrome 137+ 的**正式版**会静默忽略命令行 `--load-extension`；做扩展自动化测试请用 **Chrome for Testing**，并带 `--enable-unsafe-extension-debugging`。

---

## 版本管理

装一次之后，以后每次发版只要在程序里**点一次「更新」**：不用重下 47 MB 安装包、不用重装、不要管理员权限；装坏了能一键退回上一版，启动就崩的版本启动时自动退回。设计细节与状态机见 [`docs/版本管理.md`](./docs/版本管理.md)。

| 能力 | 说明 |
|---|---|
| 查看版本 | 应用版本 / 引擎版本 / 运行平台 / 安装版或便携版 |
| 一键更新 | 下载约 10 MB 的 `fluxdl.exe` → SHA-256 校验 → 自动替换 → 自动重启，2~3 秒完成，全程一次点击 |
| 版本库 | 已下载的版本全部留在 `app-versions\<版本>\`，可共存 N 个；设置页可切换、可删除，默认保留 3 个 |
| 语义化回退 | 切到旧版本时按钮显示「回退到 0.2.0」并二次确认；切到更高版本才叫「更新」 |
| 启动自检 | 新版本连续两次启动失败自动退回上一版；运行中崩溃不触发回退，避免正常任务被误判 |
| 失败保护 | 校验不符直接丢弃（fail-closed）；替换脚本没跑成则保持原样，绝不留下半个文件 |
| 工具版本 | yt-dlp / ffmpeg 多版本共存、随时切换、一键回滚 |

**版本号**遵循语义化版本 `MAJOR.MINOR.PATCH[-prerelease]`：主版本号是不兼容改动，次版本号是新增功能，修订号是问题修复；`-beta.1` 优先级低于同号正式版，稳定通道不推送预发布。清单里的版本号是唯一事实来源，程序只比较版本号，不看时间戳。

**为什么不做二进制差分**：bsdiff / zstd patch 要为每个历史版本准备补丁，杀软对「程序自己改自己」也很敏感。因此改为**组件级增量**——应用只下 `fluxdl.exe`（约 10 MB），工具由 `tools/` 独立管理，扩展体积可忽略。

**更新记录结构**（`update-manifest.json`，应用 / 工具 / 历史三合一）：

```json
{
  "schema": 1,
  "app": {
    "latest": "0.3.0",
    "minSupported": null,
    "releasedAt": "2026-11-06T02:23:43Z",
    "notes": ["设置页可一键切回旧版本"],
    "assets": {
      "windows-x64": { "url": "https://…/v0.3.0/fluxdl.exe", "size": 9977856, "sha256": "4eacca68…" }
    }
  },
  "tools": { "yt-dlp": { "latest": "2025.11.01", "versions": [] } },
  "history": [
    { "version": "0.3.0", "releasedAt": "…", "channel": "stable", "notes": ["…"] }
  ]
}
```

`sha256` 是强制的：清单里缺失则该更新直接拒绝，宁可更不了也不装来源不明的可执行文件。

**替换怎么落地**：新版本先入库 → 复制成 `<当前 exe>.new` → 写 `update-state.json` → 生成只含 ASCII 的 `.cmd` → 主程序退出，脚本反复尝试改名判断旧进程是否已释放（最多 60 秒）→ 备份 `.bak` → 覆盖 → 比对文件大小 → 拉起新进程。路径全部走环境变量，避开中文系统 GBK 代码页乱码。

**回滚三道闸**：① 下载后的 SHA-256 校验；② 替换脚本失败时用 `.bak` 还原；③ 启动自检 `attempts ≥ 2` 自动回退到 `previous`，`rolledBackFrom` 防止两版来回弹跳。

**触发时机**：启动 +4 秒静默检查、设置页手动检查（跳过 6 小时缓存）、启动时收尾上次未完成的替换。有更新时主界面顶部出现绿色横幅，`×` 仅对当前版本稍后提醒。

## 内置 yt-dlp / ffmpeg

启动时 `apply_bundled_tools()` 把 `EngineOptions.yt_dlp_path` / `ffmpeg_path`（序列化到 `tasks.json` 为 `ytDlpPath` / `ffmpegPath`，serde 用 camelCase）指向随包 `tools/` 目录：

- 用户手动填写且**文件真实存在**的路径优先，不会被覆盖；
- 默认值、空值、失效路径才由内置二进制顶上；
- 「一键安装」按钮发现内置工具可用时直接返回，不再联网下载。

二进制**不进 Git**：Linux 版 ffmpeg 单文件约 165 MB，超过 GitHub 单文件 100 MB 上限，四个平台二进制合计约 268 MB。仓库只保留 `tools/README.md` 与 `tools/fetch-tools.sh`，正式成品包由打包流程注入。详见 [`fluxdl/tools/README.md`](./fluxdl/tools/README.md)。

---

## 本地捕获服务协议

桌面端启动即在 `127.0.0.1:35917` 监听，**不需要独立服务器、不需要云部署**。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 健康检查，返回 JSON |
| `/api/downloads` | POST | 添加下载任务 |

公共请求头：`x-fluxdl-token: fluxdl-local-v1`。

```jsonc
// POST /api/downloads
{
  "url": "https://example.com/file.zip",
  "filename": "file.zip",      // 可选
  "referer": "https://...",    // 可选
  "kind": "http"               // 可选：http | media；缺省按 URL 自动判断
}
```

**准入规则**（`capture_guard.rs`，在 OPTIONS / health / token 校验之前执行）：

1. `Host` 必须是 `127.0.0.1` 或 `localhost` + 约定端口 —— 防 DNS rebinding；
2. `Origin` 必须为空、`chrome-extension://…` 或 `moz-extension://…`；网页来源、`null`、file 一律 403 且**不返回** `Access-Control-Allow-Origin`。

因为令牌写在扩展源码里属于公开值，单靠它挡不住网页；浏览器跨域请求必定带 `Origin` 且 JS 无法伪造，所以用 Host + Origin 兜底。

**无登录态**：0.3.0 起协议里没有 `cookies` 字段，桌面端也删掉了 `--cookies` 参数与临时凭证文件。外面传了多余字段会被忽略，不会落盘。

---

## 测试

```bash
cd FuxDL/fluxdl

# 引擎：38 单测 + 5 集成 + 9 回归 + 5 更新回滚 = 57 项
cargo test -p fluxdl-engine
cargo clippy --tests

# 前端类型检查
npx tsc --noEmit

# 捕获服务准入模块（纯 std，不依赖 Tauri，可独立跑）
rustc --test src-tauri/src/capture_guard.rs -o /tmp/cg && /tmp/cg
```

已完成的验证记录见 [`docs/验证记录.md`](./docs/验证记录.md)，包括：

- 引擎并发 / 续传 / 持久化 / media 输出 / yt-dlp 自动更新 / 版本库与启动自检 **57 项全绿**（38 单测 + 5 集成 + 9 回归 + 5 更新替换与回滚端到端）；
- 捕获服务真实 TCP 报文端到端 8 项；
- 扩展核心纯函数 27 项 + 真实 Chrome for Testing / MV3 端到端 **18/18**（资源嗅探、流媒体标记、弹窗渲染、media 任务入队、1 KB 小文件自动接管、浏览器原生下载被取消）；
- 更新与回退链路：版本库扫描只认 `<版本>\fluxdl.exe`、SHA-256 不符即丢弃、`.bak` 还原、`boot_guard` 两次启动失败自动回退、`prune` 保留 3 版；替换脚本用环境变量传路径（中文目录不乱码）；
- 视频链路：页面 URL → 单次 `yt-dlp` + `--concurrent-fragments 4`，B 站带 `player_client=tv,app`；直链 → 8 路 Range 并行；失败即报错，不再空转；
- Ubuntu 桌面端 Xvfb 实跑、真实下载 + `tar tzf` 校验；
- Linux 便携包解压后全新数据目录启动、自动识别内置工具并完成真实下载（历史验证；该包现已停发）。

---

## 安全说明与已知限制

| 项 | 现状 | 建议 |
|---|---|---|
| 本地令牌 | `fluxdl-local-v1` 是写死在扩展里的公开常量，本机任意进程都能添加任务 | 改为运行时随机令牌 + 扩展配对；会动扩展里写死的常量，需同步更新扩展与桌面端 |
| CSP | `csp: null` | 公开发布前收紧 |
| 扩展权限 | `host_permissions: <all_urls>`（资源嗅探需要），已无 `cookies` 权限 | 评估是否收窄到具体站点；登录凭证不再经过扩展 |
| 下载目标 | `engine.add()` 只接受 `http` / `https`，响应只落本地文件 | 仍存在本机发起内网探测的可能，多用户机器需注意 |
| Windows | 依赖 WebView2 Runtime | 系统缺失时提示用户安装 |
| 视频站点 | 只保留国内站点（B 站、抖音、快手、优酷、腾讯视频等）的主机名判定；YouTube 等国外站点点进来会走普通 HTTP 下载并明确报错 | 需要国外站点请自备可用网络环境后手工调 `yt-dlp`，不在官方支持范围 |
| Linux 交付 | 已停发 Linux 成品包，源码仍可自行构建 | 需要时自行 `cargo build --release` |
| `dist/` | 前端构建产物，不进 Git | 由 `npm run build` 生成 |

---

## 变更记录

| PR | 内容 | 合并提交 |
|---|---|---|
| [#2](https://github.com/Supenman/FuxDL/pull/2) | 引擎文件完整性 P0-1 / P0-2 与 P1 稳定性（同路径并发、part 丢失补零、原子持久化、runner 原子性、probe 重试），新增 9 个回归测试 | `df48149` |
| [#3](https://github.com/Supenman/FuxDL/pull/3) | 本地捕获服务安全加固：新增 `capture_guard.rs`，Host + Origin 准入，移除无条件 `ACAO: *` | `c1bc99b` |
| [#4](https://github.com/Supenman/FuxDL/pull/4) | 扩展 v2：无范围自动接管、IDM 式资源嗅探、视频站点 media 解析；内置 yt-dlp / ffmpeg 自动探测；修复资源缓存并发覆盖与 `hidden` 样式覆盖 | `41584eda` |
| [#5](https://github.com/Supenman/FuxDL/pull/5) | 文档：重写根目录 README，归档代码审查、改进方案、P0-3 专项与验证记录 | `a50f7748` |
| [#6](https://github.com/Supenman/FuxDL/pull/6) | 修复 Windows 中文系统下 yt-dlp 写 stdout 触发 `Errno 22` 崩溃；统一 UTF-8 输出、字节级读取 stdout/stderr、目录差分定位视频产物 | `77e88d2e` |
| [#7](https://github.com/Supenman/FuxDL/pull/7) | 视频站点自动携带浏览器登录 cookie，修 YouTube `Sign in to confirm you're not a bot`；新增 `cookies` 权限、临时凭证文件用完即删、弹窗开关、bot 报错中文指引；修复 `data_dir` 被 move 的编译错误；交付收敛为仅 Windows | `7d16baec` |
| [#8](https://github.com/Supenman/FuxDL/pull/8) | 视频报 `Requested format is not available` 时自动降级重试：换不依赖 PO Token 的 yt-dlp 客户端、放宽格式链、cookie 跨两轮存活、中文排障指引；正常路径零改动 | `96fc10446` |
| [#9](https://github.com/Supenman/FuxDL/pull/9) | yt-dlp 自动更新 + 处理 YouTube「页面需重载」报错：新增 `ytdlp.rs` 后台静默更新随包内置 yt-dlp（24h 冷却、并发互斥、失败静默、镜像回退）；`media.rs` 识别该报错后强制更新并重试；`EngineOptions.autoUpdateYtDlp` 开关（默认开），设置页可关 | `4efc490f` |
| [#10](https://github.com/Supenman/FuxDL/pull/10) | 版本管理：新增 `update.rs`（语义化版本、清单解析、sha256 校验、暂存替换与崩溃恢复）、`src-tauri/version.rs`（检查更新 / 下载暂存 / 重启替换 / 历史）、`src-tauri/tools.rs`（yt-dlp 与 ffmpeg 多版本共存、切换、回滚）；设置页「版本与更新」+ 主界面更新横幅；版本号升至 0.2.0 | 见仓库历史 |
| [#11](https://github.com/Supenman/FuxDL/pull/11) | 0.3.0 更新链路重构：去掉启动器，改为「版本库 + 延迟替换脚本 + 启动自检」；更新一次点击全自动（下载→校验→替换→重启）；新增 `appversion.rs`（版本库扫描、`boot_guard`、`mark_healthy`、`prune`）；设置页可切回旧版本；视频链路移除 cookie 与递归重试，只保留国内站点、分片并发 4 路 | 本条 |

当前 `main` 已包含上述全部改动（文档可能在此之后继续同步，具体提交号以仓库 commit 历史为准）。`dist/`（前端构建产物）与 `tools/` 下的工具二进制按设计不进 Git，二进制统一走 Releases 发布。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [`docs/代码审查.md`](./docs/代码审查.md) | 按 P0~P3 分级的第一轮代码审查报告 |
| [`docs/改进方案.md`](./docs/改进方案.md) | 缺陷根因、修复方案、验证数据与推送记录 |
| [`docs/P0-3-本地服务安全加固.md`](./docs/P0-3-本地服务安全加固.md) | 漏洞机理、准入设计、端到端验证、残余风险 |
| [`docs/验证记录.md`](./docs/验证记录.md) | 扩展 v2.2、0.3.0 更新与回退链路、成品包的完整验证结果 |
| [`docs/版本管理.md`](./docs/版本管理.md) | 版本号规则、版本库结构、八步更新流程、启动自检与回退状态机、边界情况 |
| [`fluxdl/tools/README.md`](./fluxdl/tools/README.md) | 内置工具来源、体积与获取方式 |
