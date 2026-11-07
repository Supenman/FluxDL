//! 视频 / 音频任务：把整条链接交给 yt-dlp 子进程处理。
//!
//! 0.3.0 起的策略（方案 A：只服务国内站点）
//! ----------------------------------------
//! * **一次直下**：不再针对 YouTube 的 bot 挑战做「换客户端 → 更新 yt-dlp → 再重试」
//!   的多轮递归。旧实现失败时会连着跑三轮 yt-dlp，UI 上表现为「下载中 0 B / 未知」
//!   长时间空转，用户以为卡死。现在失败就是失败，报错即止，原因一眼可见。
//! * **不落凭证**：不再接收 / 写盘 cookies.txt，磁盘上不会留下任何登录态。
//! * **并发分片**：`--concurrent-fragments 4`，DASH / HLS 的音视频分片并发拉取，
//!   这是对 B 站、抖音这类分片流最直接的提速手段。
//! * **B 站客户端**：`--extractor-args bilibili:player_client=tv,app` 绕开 web 端最严
//!   的单连接限速（web 端匿名下载常年只有 ~120 KB/s）。
//! * **aria2 外部下载器**（0.3.1 起）：把「取字节」这一步换成 aria2 的 `-x16 -s16`，
//!   按字节区间并发拉取，绕开单连接限速。合并 / 选格式 / 异常兜底仍由 yt-dlp 负责。
//!   找不到 aria2c 或用户给任务限了速时，自动退回 yt-dlp 原生下载器。

use crate::aria2;
use crate::manager::{Engine, EngineError, TaskEntry};
use crate::types::*;
use crate::util;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// 进度行协议：`FLUXDL|已下载字节|总字节|预估总字节|速度(B/s)|剩余秒|文件名`
///
/// 别改字段顺序 —— `run()` 里的 `splitn(6, '|')` 依赖它：第 6 段之后
/// 整体当作文件名，这样文件名里带 `|` 也撑不破协议。
/// aria2 模式复用同一行格式，只是文件名位留空（aria2 不知道最终输出名）。
const PROGRESS_TEMPLATE: &str = "download:FLUXDL|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.filename)s";

/// 默认格式选择：优先「最佳视频流 + 最佳音频流」合并，退到整体 best。
const DEFAULT_FORMAT: &str = "bv*+ba/b";

/// 分片并发数。国内站点的 DASH / HLS 流普遍支持多分片并发，
/// 4 路是在「提速明显」与「不触发风控」之间的折中值。
const CONCURRENT_FRAGMENTS: u8 = 4;

/// 单连接下载只有 ~120 KB/s 出头时，B 站 web 端几乎必然是瓶颈，换 tv/app 客户端。
const SLOW_SPEED_THRESHOLD: u64 = 300 * 1024;
/// 判定「慢」之前先观察这么久，避开 TCP 慢启动阶段。
const SLOW_SPEED_WINDOW: Duration = Duration::from_secs(15);

/// 逐行读取子进程输出，一直读到 EOF 才关闭读端。
///
/// 不能用 `BufReader::lines()`：它遇到非法 UTF-8 会返回 `Err`，旧实现写成
/// `while let Ok(Some(line))` 会因此提前退出、drop 掉 stdout 读端。Windows
/// 中文系统下 PyInstaller 版 `yt-dlp.exe` 的 stdout 默认走系统 ANSI 代码页
/// （GBK），进度模板里带中文文件名时就会产出非法 UTF-8 字节。管道读端一关，
/// yt-dlp 再写 stdout 拿到 Windows CRT 映射出来的 EINVAL(22)，于是报
/// `Unable to download video: [Errno 22] Invalid argument`，退出时 flush
/// 又抛一次 `Exception ignoring while flushing sys.stdout`。
///
/// 改为读原始字节 + lossy 解码：编码问题最多让某一行显示成乱码，不会中断下载。
#[allow(dead_code)]
fn spawn_line_reader<R>(reader: R, tx: mpsc::UnboundedSender<String>, prefix: &'static str)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break, // 真正的 EOF，此时关闭读端才安全
                Ok(_) => {
                    while let Some(&last) = buf.last() {
                        if last == b'\n' || last == b'\r' {
                            buf.pop();
                        } else {
                            break;
                        }
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    let _ = tx.send(format!("{prefix}{line}"));
                }
                Err(_) => break, // 只有真实 IO 错误才停止
            }
        }
    });
}

/// 链接是否指向 B 站（含短链 b23.tv）。
///
/// 必须按「主机名」判断，不能用 `contains`：否则 `https://example.com/b23.tv-x`
/// 这种把域名写进路径的链接会被误判成 B 站，进而套上一个错误的提取器参数。
fn is_bilibili(url: &str) -> bool {
    let host = host_of(url);
    const HOSTS: &[&str] = &["bilibili.com", "b23.tv", "biliapi.net"];
    HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// 判断 yt-dlp 输出的文本是否为编码损坏的乱码。
///
/// Windows 中文系统下 PyInstaller 版 `yt-dlp.exe` 的 stdout 可能按系统 ANSI 代码页
/// 输出，Rust 侧 `from_utf8_lossy` 会把非法字节变成 U+FFFD；也可能整串 UTF-8 字节
/// 被按 Latin-1 解读成 `Ãœ`、`â€`、`ÜŨ` 这类典型 mojibake。
///
/// **只丢确定是编码损坏的信号**。0.3.3 曾按「非 ASCII 里非 CJK 占比」猜测，并把
/// `Ã`/`Â` 当硬命中，结果葡语 `SÃO`、俄语、泰文和含 emoji 的合法标题全被丢弃，
/// 下载中一直显示默认名 `video (1)`。宁可偶尔漏一个乱码，也不能误杀正常标题。
fn looks_mojibake(s: &str) -> bool {
    // 解码失败的替换字符 / UTF-8 被按 Latin-1 解读的典型序列
    if s.contains('\u{FFFD}') || s.contains("â€") {
        return true;
    }
    // C1 控制区：UTF-8 字节被按 Latin-1 解读后残留的控制字符
    if s.chars().any(|c| ('\u{0080}'..='\u{009F}').contains(&c)) {
        return true;
    }
    // 真机样本 `4K|⯃ÜŨ♦GGotBBang♦`：正常标题不会堆三个以上
    // 「既非字母数字、也非 CJK / 假名 / 谚文 / emoji / 常见标点」的怪异符号。
    let weird = s.chars().filter(|c| is_weird_glyph(*c)).count();
    weird >= 3
}

/// 既不是字母数字空白、也不是 CJK / 假名 / 谚文 / emoji / 合法装饰标点的怪字符。
fn is_weird_glyph(c: char) -> bool {
    if c.is_ascii() || c.is_alphanumeric() || c.is_whitespace() {
        return false;
    }
    if ('\u{4E00}'..='\u{9FFF}').contains(&c)
        || ('\u{3040}'..='\u{30FF}').contains(&c)
        || ('\u{AC00}'..='\u{D7AF}').contains(&c)
        || ('\u{FF00}'..='\u{FFEF}').contains(&c)
        || ('\u{3000}'..='\u{303F}').contains(&c)
        || ('\u{1F000}'..='\u{1FAFF}').contains(&c)
    {
        return false;
    }
    !matches!(
        c,
        '·' | '—' | '…' | '♪' | '♫' | '★' | '☆' | '●' | '○' | '◆' | '◇' | '■'
            | '□' | '♥' | '♡' | '《' | '》' | '「' | '」' | '【' | '】' | '（'
            | '）' | '、' | '。' | '，' | '！' | '？' | '：' | '；' | '～'
            | '＋' | '－' | '／' | '＼' | '｜' | '％' | '＆' | '＃' | '＠'
            | '￥' | '“' | '”' | '‘' | '’'
    )
}

/// aria2 是否适合接管该链接的字节传输（URL 层防御性兜底）。
///
/// 主裁决已上移到 `Engine::add`：0.3.4 起所有 `TaskKind::Media` 一律关闭 aria2，
/// 只有整文件 HTTP 直链才用它做多连接 —— 按站点逐个排除分片流永远会漏站点。
/// 这里保留 B 站判断，防止将来有绕过 manager 直接构造媒体任务的入口重新踩坑。
///
/// 原因：DASH 分片普遍 100 KB 级，远小于 aria2 的 `-k4M` 切分阈值，aria2 恒用
/// 1 条连接（真机 `CN:1 DL:0B`）还要为每片多起进程；分片之间并发应交给
/// yt-dlp 的 `--concurrent-fragments`。
fn aria2_suits_url(url: &str) -> bool {
    !is_bilibili(url)
}

/// 从 URL 里抽出小写主机名，去掉端口与 userinfo。不是合法 URL 时返回空串。
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let rest = rest.split(['/', '?', '#']).next().unwrap_or("");
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
    let rest = rest.split(':').next().unwrap_or("");
    rest.to_ascii_lowercase()
}

/// 把抖音「精选 / 推荐 / 个人主页」里带 `modal_id` 的聚合页归一化成
/// yt-dlp 唯一认识的 `https://www.douyin.com/video/<id>`。
///
/// 0.3.5 真机截图：`https://www.douyin.com/jingxuan?modal_id=7702008165390421263`
/// 被扩展当作「本页视频」发送，yt-dlp 落到 `[generic]` 报 `Unsupported URL`。
/// `modal_id` 本身就是 aweme id，改写后能命中 `[Douyin]` 提取器 —— 至少让失败
/// 原因从「链接不认识」变成真实的站点风控 / cookie 门槛，便于给出可操作指引。
///
/// **只改写传给 yt-dlp 的链接**：任务记录里的原始 URL、referer、日志都保持不变，
/// 用户看到的「来源」不会被悄悄改掉。其它站点、已是 `/video/<id>`、无
/// `modal_id` 或 `modal_id` 非纯数字时原样返回。
fn normalize_media_url(url: &str) -> String {
    let host = host_of(url);
    let is_douyin = host == "douyin.com"
        || host.ends_with(".douyin.com")
        || host == "iesdouyin.com"
        || host.ends_with(".iesdouyin.com");
    if !is_douyin {
        return url.to_string();
    }
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path = after_scheme.split(['?', '#']).next().unwrap_or("");
    let path = path.split_once('/').map(|(_, p)| p).unwrap_or("");
    if path.starts_with("video/") {
        return url.to_string();
    }
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    let query = query.split('#').next().unwrap_or("");
    let id = query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k == "modal_id" && !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) {
            Some(v)
        } else {
            None
        }
    });
    match id {
        Some(id) => format!("https://www.douyin.com/video/{id}"),
        None => url.to_string(),
    }
}

/// URL 是否为可直接多连接下载的整文件（容器格式），而非需要 yt-dlp 解析的视频页。
/// CDN 直链常常仍带站点后缀（如 `v2.kuaishou.com/xxx.mp4`），按主机名判媒体会把
/// 它错建成媒体任务再交给 yt-dlp 报 `Unsupported URL`；这类链接必须走 HTTP 直链。
/// 只列完整容器文件，不含 `.m3u8 / .mpd / .m4s` 分片 —— 那些仍需 yt-dlp 合并。
///
/// 本函数是跨层权威规则：由 `lib.rs` 导出给 Tauri 建任务时复用；前端
/// `isDirectMediaFile` 与扩展同名函数实现等价判定，由契约脚本逐项校验。
pub fn is_direct_media_file(url: &str) -> bool {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path = rest.split(['?', '#']).next().unwrap_or("");
    let last = path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    const EXTS: &[&str] = &[
        ".mp4", ".m4v", ".mkv", ".webm", ".mov", ".flv", ".avi", ".ts", ".mp3", ".m4a",
        ".aac", ".flac", ".wav", ".ogg", ".opus",
    ];
    EXTS.iter().any(|e| last.ends_with(e))
}

/// 独占工作目录的生命周期守卫。
///
/// 0.3.6 之前只在一处清理 `fluxdl-<id>` 子目录：下载成功且产物已 rename 回
/// 用户下载目录。yt-dlp 失败、用户暂停、子进程启动失败、「找不到输出文件」
/// 都直接 return，目录连同 `.part` / `.ytdl` / 分片一起留在下载目录 —— 用户
/// 每失败一次就多一个垃圾文件夹（真机截图已复现）。用 RAII 覆盖所有退出
/// 路径（含 `?`、暂停、panic unwind）。暂停也清理：独占目录若被复用，目录快照
/// 差分会把上次的 .part 当成「本次新增」误判为产物，反而更危险。
struct WorkDirGuard {
    path: PathBuf,
    keep: bool,
}

impl WorkDirGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn keep(&mut self) {
        self.keep = true;
    }

    /// 目录里是否存在完整（非中间态）媒体文件。
    /// 用于「下载完成但没能定位产物」时决定保留还是清理，避免误删已下好的视频。
    fn has_complete_media(&self) -> bool {
        let Ok(entries) = std::fs::read_dir(&self.path) else {
            return false;
        };
        entries.flatten().any(|e| {
            let Ok(meta) = e.metadata() else {
                return false;
            };
            if !meta.is_file() || meta.len() == 0 {
                return false;
            }
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            !name.ends_with(".part")
                && !name.ends_with(".ytdl")
                && !name.ends_with(".tmp")
                && !name.ends_with(".fluxdl-part")
                && is_media_ext(&name)
        })
    }
}

impl Drop for WorkDirGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

/// 桌面端新建媒体任务时，对「必然无法整页解析」的网页链接给出提前拦截提示。
///
/// 0.3.6：真机截图显示用户把快手 / 抖音**页面 URL** 粘贴进新建任务，会被建成
/// Media 任务，然后 yt-dlp 报 `Unsupported URL` / `Fresh cookies`，留下一个失败
/// 任务和红色报错。页面 URL 不是视频文件，只有浏览器扩展嗅探到的 CDN 直链才能
/// 下载；与其创建必然失败的任务，不如在建任务时直接给出可操作指引。
///
/// 返回 `Some(提示)` 表示应拒绝，`None` 表示照常交给 yt-dlp 尝试。只覆盖已证实
/// 不可解析的站点 / 页面，B 站等正常站点不受影响；容器直链永不拦截。
pub fn media_page_blocker(url: &str) -> Option<&'static str> {
    if is_direct_media_file(url) {
        return None;
    }
    let host = host_of(url);
    let is_ks = host == "kuaishou.com"
        || host.ends_with(".kuaishou.com")
        || host == "kwai.com"
        || host.ends_with(".kwai.com");
    if is_ks {
        return Some("快手网页链接无法整页解析（内置视频解析器没有该站点的提取器）。请在浏览器扩展弹窗的「本页资源」里选择视频直链下载，或把直链地址粘贴为普通下载任务");
    }
    let is_dy = host == "douyin.com"
        || host.ends_with(".douyin.com")
        || host == "iesdouyin.com"
        || host.ends_with(".iesdouyin.com");
    if is_dy {
        return Some("抖音网页解析需要浏览器下发的匿名校验 cookie，FluxDL 不读取、传输或保存任何凭证，因此不解析这类页面。请在浏览器扩展弹窗的「本页资源」里选择视频直链下载");
    }

    // 其它站点的首页 / 发现页 / 精选页：不是单个视频详情页。
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path = after_scheme.split(['?', '#']).next().unwrap_or("");
    let path = path.split_once('/').map(|(_, p)| p).unwrap_or("");
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    let has_id = query.split('&').any(|kv| {
        kv.split_once('=')
            .map(|(k, v)| {
                k == "modal_id" && !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())
            })
            .unwrap_or(false)
    });
    let aggregate = path.is_empty()
        || matches!(
            path.split('/').next().unwrap_or("").to_ascii_lowercase().as_str(),
            "jingxuan"
                | "discover"
                | "new-reco"
                | "hot"
                | "feed"
                | "recommend"
                | "explore"
                | "home"
                | "index"
                | "channel"
        );
    if aggregate && !has_id {
        return Some("这是站点首页 / 发现页 / 精选页，不是单个视频详情页，无法整页解析。请打开要下载的那个视频再试，或在浏览器扩展弹窗的「本页资源」里选择视频直链");
    }
    None
}

pub async fn run(
    engine: &Arc<Engine>,
    entry: &Arc<TaskEntry>,
    token: CancellationToken,
) -> Result<(), EngineError> {
    let options = engine.options();
    let (save_dir, placeholder) = {
        let view = entry.view.lock().await;
        (
            PathBuf::from(&view.save_path)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(&options.save_dir)),
            view.filename.clone(),
        )
    };
    util::ensure_dir(&save_dir)?;
    // 每个媒体任务独占一个输出子目录。yt-dlp 的输出名固定为
    // `%(title) [%(id)s].%(ext)s`，所有任务共用 save_dir 会互相「文件已存在」
    // 跳过下载（退出 0 但不打 FLUXDONE），目录快照差分也会跨任务错配、
    // 认领到别的任务或上次留下的旧文件（0.3.3 的完成却指向无关视频）。
    // 独占目录让所有兜底查找只在本次任务的空目录里进行，从根上消除这两类误判。
    let short_id: String = entry.id.chars().take(8).collect();
    let work_dir = save_dir.join(format!("fluxdl-{short_id}"));
    util::ensure_dir(&work_dir)?;
    // 0.3.6：RAII 覆盖所有退出路径。以前只有「成功发布产物」一处清理，
    // 失败 / 暂停 / spawn 失败 / 找不到输出都会留下垃圾目录。只有下面两处
    // 确实需要把完整产物留在目录内时才 keep()，其余一律由 Drop 自动删除。
    let mut guard = WorkDirGuard::new(work_dir.clone());
    // 先拍一份目录快照：`--print after_move` 给出的路径若因编码 / 版本差异
    // 无法解析，仍可靠「本次运行新增或变新的文件」定位 yt-dlp 的真实产物。
    let before = snapshot_files(&work_dir);
    // 0.3.5：抖音「精选 / 推荐 / 主页」带 modal_id 的聚合页统一归一化成
    // yt-dlp 唯一认识的 /video/<id> 再交给它。**只改写传给 yt-dlp 的链接**：
    // 任务记录、referer、日志里的来源 URL 保持原样，用户看到的「来源」不会被悄悄改掉。
    let media_url = normalize_media_url(&entry.url);

    let bin = options.yt_dlp_path.trim();
    let bin = if bin.is_empty() { "yt-dlp" } else { bin };

    // —— 真实标题回填（修复 B）——
    // 轻量探测：只取标题、不下字节，让「下载中」阶段就能显示视频标题而非默认 "video"。
    // 结果写入 title_slot，主循环 emit 时顺手取走回填；失败（风控 / 网络抖动）保持默认，
    // 绝不阻塞下载主流程。B 站与正式下载一致用 tv/app 客户端。
    let title_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    {
        let slot = title_slot.clone();
        let bin = bin.to_string();
        // 标题探测必须与正式下载用同一份归一化链接；否则聚合页先报
        // Unsupported URL，标题永远停在默认名 "video"。
        let url = media_url.clone();
        let is_bili = is_bilibili(&entry.url);
        let referer = entry.options.referer.clone();
        let proxy = entry.proxy.clone();
        tokio::spawn(async move {
            let mut p = Command::new(&bin);
            p.args(["--skip-download", "--no-warnings", "--no-playlist", "--print", "%(title)s"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .env("PYTHONUTF8", "1")
                .env("PYTHONIOENCODING", "utf-8:replace")
                .env("PYTHONUNBUFFERED", "1");
            if is_bili {
                p.arg("--extractor-args").arg("bilibili:player_client=tv,app");
            }
            if let Some(r) = referer.filter(|s| !s.is_empty()) {
                p.arg("--referer").arg(r);
            }
            if let Some(pr) = proxy.filter(|s| !s.trim().is_empty()) {
                p.arg("--proxy").arg(pr);
            }
            #[cfg(windows)]
            {
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                p.creation_flags(CREATE_NO_WINDOW);
            }
            p.arg(&url);
            if let Ok(out) = p.output().await {
                if out.status.success() {
                    if let Some(t) = String::from_utf8_lossy(&out.stdout)
                        .lines()
                        .map(|l| l.trim())
                        .find(|l| !l.is_empty())
                    {
                        // 编码损坏的标题绝不回填：宁可显示默认名，也不要把一串
                        // U+FFFD / Latin-1 mojibake 展示给用户（真机截图已复现）。
                        // 真实标题会在收尾时由磁盘产物名覆盖。
                        if !looks_mojibake(t) {
                            *slot.lock().unwrap() = Some(t.to_string());
                        }
                    }
                }
            }
        });
    }

    // aria2c：任务允许 && 站点适合 && 二进制存在，三者都满足才接管取字节；
    // 任一不满足就走 yt-dlp 原生下载器，功能不降级。
    // 0.3.4 起 Engine::add 已对所有 Media 任务关闭 aria2（分片流恒 CN:1），
    // 这里再叠加 aria2_suits_url 作为 URL 层兜底，防止其他入口重新启用。
    let aria2_bin = if entry.options.aria2 && aria2_suits_url(&entry.url) {
        aria2::locate(&aria2_candidates(&options))
    } else {
        None
    };
    // aria2 自己的日志落在临时目录，出问题时可回溯它为什么慢 / 为什么断。
    let aria2_log = std::env::temp_dir().join(format!("fluxdl-aria2-{}.log", entry.id));

    let mut cmd = Command::new(bin);
    cmd.arg("--newline")
        .arg("--no-playlist")
        .arg("--quiet")
        .arg("--progress")
        .arg("--no-warnings")
        .arg("--retries")
        .arg("5")
        .arg("--fragment-retries")
        .arg("10")
        // 分片流并发：B 站 / 抖音的 DASH 音视频都是分片下发，串行拉取等于自废带宽。
        .arg("--concurrent-fragments")
        .arg(CONCURRENT_FRAGMENTS.to_string())
        .arg("--progress-template")
        .arg(PROGRESS_TEMPLATE)
        .arg("--print")
        .arg("after_move:FLUXDONE|%(filepath)s")
        .arg("-P")
        .arg(&work_dir)
        .arg("-o")
        .arg("%(title).150B [%(id)s].%(ext)s")
        .arg("-f")
        .arg(entry.options.format.as_deref().unwrap_or(DEFAULT_FORMAT))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Windows 中文系统下 yt-dlp.exe 的 stdout 默认按系统 ANSI 代码页
        // （GBK）编码，而 Rust 端按 UTF-8 解析。强制 Python 侧统一用 UTF-8，
        // 从源头避免进度行 / 文件路径里的中文变成非法 UTF-8 字节。
        // PYTHONUNBUFFERED 让进度在管道下也能逐行实时送达。
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8:replace")
        .env("PYTHONUNBUFFERED", "1")
        .kill_on_drop(true);

    // B 站：显式指定 tv / app 客户端。web 端匿名单连接被限速到 ~120 KB/s，
    // 而 tv/app 客户端拿到的下发地址限速宽松得多。
    if is_bilibili(&entry.url) {
        cmd.arg("--extractor-args").arg("bilibili:player_client=tv,app");
    }
    if let Some(ffmpeg) = options.ffmpeg_path.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--ffmpeg-location").arg(ffmpeg.trim());
        cmd.arg("--merge-output-format").arg("mp4");
    }
    if let Some(proxy) = entry.proxy.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--proxy").arg(proxy.trim());
    }
    if let Some(referer) = entry.options.referer.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--referer").arg(referer);
    }
    // 外部下载器要放在 URL 之前，且必须在所有「会影响解析」的参数之后：
    // yt-dlp 会先解析出直链，再把每条直链交给 aria2c 拉取。
    if let Some(bin) = aria2_bin.as_ref() {
        cmd.arg("--external-downloader").arg(bin);
        cmd.arg("--external-downloader-args")
            .arg(aria2::downloader_args(&aria2_log));
        // 注意：**不要**在这里把 `--concurrent-fragments` 压成 1。
        //
        // 上一版曾加过 `--concurrent-fragments 1`，理由是「外部下载器模式下 yt-dlp
        // 不再参与取字节」。这个假设只对「整文件直链」成立；对 B 站 DASH 这类**分片流**
        // 是错的——yt-dlp 仍然要逐片拉取，每一片单独交给 aria2c。压成 1 等于把原本
        // 4 路并发的分片拉取退化成串行，实测比原生下载还慢，是明确的性能回归。
        //
        // 分片流的正确并发模型是：分片之间由 yt-dlp 并发（CONCURRENT_FRAGMENTS），
        // 单片之内由 aria2c 尽力（小片建连开销大，aria2 会自动跳过切分）。
    }
    // 媒体任务的字节由 yt-dlp 子进程取，引擎的令牌桶（http.rs 里的 limiter.acquire）
    // 管不到它。把任务级 / 全局限速翻译成 yt-dlp 的 --limit-rate，否则设置里的
    // 限速对视频任务完全无效，而 HTTP 直链却正常减速，行为不一致。
    let media_limit = entry
        .limiter
        .limit()
        .into_iter()
        .chain(engine.global_limit().limit())
        .min();
    if let Some(rate) = media_limit.filter(|v| *v > 0) {
        cmd.arg("--limit-rate").arg(rate.to_string());
    }
    // 用归一化后的链接（抖音聚合页 -> /video/<id>）；原始来源 URL 只用于任务记录 / referer。
    cmd.arg(&media_url);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            EngineError::message(format!(
                "未找到 yt-dlp（{bin}）。请安装 yt-dlp，或在设置中填写完整路径"
            ))
        } else {
            EngineError::message(format!("启动 yt-dlp 失败：{e}"))
        }
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // 管道分工在两种模式下完全不同，别照抄：
    //
    // · 原生模式：yt-dlp 的进度模板走 **stdout**（`--newline`），报错走 stderr。
    // · aria2 模式：yt-dlp 不再逐行打进度，只有收尾一行 + `FLUXDONE`；真正的
    //   进度是 aria2 自己打的，而且 —— 实测（aria2 1.37）**全部落在 stdout**，
    //   stderr 只有 0 字节。所以两个管道都要过「会认领进度行」的 reader，
    //   否则进度行会被当成普通日志丢掉，UI 从头到尾停在 0%。
    let aria2_mode = aria2_bin.is_some();
    if let Some(stdout) = stdout {
        spawn_aria2_progress_reader(stdout, tx.clone(), aria2_mode);
    }
    if let Some(stderr) = stderr {
        spawn_aria2_progress_reader(stderr, tx.clone(), aria2_mode);
    }
    drop(tx);

    {
        let mut view = entry.view.lock().await;
        view.status = TaskStatus::Downloading;
    }
    engine.emit_task(entry).await;

    let mut final_path: Option<PathBuf> = None;
    let mut errors: Vec<String> = Vec::new();
    let mut last_emit = std::time::Instant::now();
    let started = std::time::Instant::now();
    let mut speed_hinted = false;

    loop {
        let next = tokio::select! {
            _ = token.cancelled() => {
                let _ = child.kill().await;
                return Err(EngineError::Paused);
            }
            line = rx.recv() => line,
        };
        let Some(line) = next else { break };

        // 调试开关：设置 FLUXDL_DEBUG_PROGRESS=1 时把子进程每一行原样打到 stderr，
        // 用于排查「进度不刷新 / 报错被吞」。默认关闭，不影响正常运行。
        if std::env::var("FLUXDL_DEBUG_PROGRESS").is_ok() {
            eprintln!("[raw] {line}");
        }

        if let Some(rest) = line.strip_prefix("FLUXDL|") {
            let parts: Vec<&str> = rest.splitn(6, '|').collect();
            if parts.len() >= 5 {
                let downloaded = parts[0].parse::<u64>().unwrap_or(0);
                let total = parts[1]
                    .parse::<u64>()
                    .ok()
                    .filter(|v| *v > 0)
                    .or_else(|| parts[2].parse::<u64>().ok())
                    .unwrap_or(0);
                // speed 字段来自 aria2：`-1` 表示「速度未知」（DL:--），此时保留
                // 上一次有效速度，避免图表谷底塌陷到 0 造成虚假锯齿；其余值照常采用。
                let raw_speed: i64 = parts[3].parse().unwrap_or(-1);
                let speed = if raw_speed >= 0 { raw_speed as u64 } else { 0 };
                let eta = parts[4].parse::<f64>().ok().map(|v| v.max(0.0) as u64);

                // 单连接长期低速时给一次可操作的提示（每个任务只提示一次）。
                if !speed_hinted
                    && started.elapsed() > SLOW_SPEED_WINDOW
                    && speed > 0
                    && speed < SLOW_SPEED_THRESHOLD
                {
                    speed_hinted = true;
                    engine.emit_log(
                        &entry.id,
                        "当前速度偏低：多为站点对单连接限速或本机网络瓶颈，可在设置里配置代理后重试",
                    );
                }

                entry.downloaded.store(downloaded, Ordering::Relaxed);
                let mut view = entry.view.lock().await;
                view.total_bytes = total;
                view.downloaded_bytes = downloaded;
                // 速度未知（-1）时保留上一次有效速度，不归零。
                if raw_speed >= 0 {
                    view.speed_bps = raw_speed as u64;
                }
                view.eta_seconds = eta;
                // 注意：进度行的 filename 是 yt-dlp 当前正在写的中间文件名（分片 / .part），
                // 用它覆盖任务名会把真实标题污染成中间名，因此不写入 view.filename；
                // 最终文件名由收尾的 FLUXDONE / 目录差分兜底决定。
                view.mime = Some("video/*".into());
                drop(view);
                if last_emit.elapsed() > std::time::Duration::from_millis(400) {
                    last_emit = std::time::Instant::now();
                    // 标题探测完成则回填（只覆盖默认名 "video*"，不动最终产物名）
                    let probed = if let Ok(mut g) = title_slot.lock() {
                        g.take()
                    } else {
                        None
                    };
                    if let Some(t) = probed {
                        let clean = util::sanitize_filename(&t);
                        if !clean.is_empty() {
                            let mut view = entry.view.lock().await;
                            if view.filename.starts_with("video") {
                                view.filename = clean;
                            }
                            drop(view);
                        }
                    }
                    engine.emit_task(entry).await;
                }
            }
        } else if let Some(rest) = line.strip_prefix("FLUXDONE|") {
            let path = PathBuf::from(rest.trim());
            // `-P` 指向独占 work_dir，相对路径必须相对它解析；旧实现按 save_dir
            // 拼接会把产物指到错误位置，进而落回兜底查找。
            final_path = Some(if path.is_absolute() {
                path
            } else {
                work_dir.join(path)
            });
        } else if let Some(rest) = line.strip_prefix("ERR|") {
            let rest = rest.trim();
            if rest.is_empty() {
                continue;
            }
            errors.push(rest.to_string());
            if errors.len() > 24 {
                errors.remove(0);
            }
            engine.emit_log(&entry.id, rest);
        }
    }

    let status = child.wait().await?;
    if token.is_cancelled() {
        return Err(EngineError::Paused);
    }
    if !status.success() {
        let tail = errors
            .iter()
            .rev()
            .take(4)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" / ");
        let hint = failure_hint(&errors, &entry.url);
        return Err(EngineError::message(if tail.is_empty() {
            format!("yt-dlp 退出码 {:?}{hint}", status.code())
        } else {
            format!("yt-dlp 失败：{tail}{hint}")
        }));
    }

    // FLUXDONE 里的路径在 Windows 中文系统下可能是 GBK 字节，lossy 解码后
    // 会变成乱码路径。此时先用「目录快照差分」找真实产物，再退回文件名匹配。
    // 两者都只在本次任务独占的 work_dir 里找，绝不会认领别的任务或旧文件。
    let mut resolved = final_path.filter(|p| p.exists());
    if resolved.is_none() {
        resolved = find_new_output(&work_dir, &before)
            .or_else(|| find_output(&work_dir, &placeholder));
    }

    let mut view = entry.view.lock().await;
    if let Some(path) = resolved {
        // 把产物从独占目录发布回用户选择的下载目录；只有发布成功才清理中间目录。
        let published = publish_output(&path, &save_dir);
        let kept_in_work_dir = published.starts_with(&work_dir);
        if let Some(name) = published.file_name() {
            view.filename = name.to_string_lossy().to_string();
        }
        view.save_path = published.to_string_lossy().to_string();
        let size = std::fs::metadata(&published).map(|m| m.len()).unwrap_or(0);
        view.total_bytes = size.max(view.downloaded_bytes);
        view.downloaded_bytes = view.total_bytes;
        entry.downloaded.store(view.total_bytes, Ordering::Relaxed);
        if kept_in_work_dir {
            // rename 失败，完整产物仍在独占目录里：必须保留目录，否则会被 guard 一起删掉。
            guard.keep();
        }
        // 否则 guard 在函数返回时清掉整个独占目录（含 .part / .ytdl / .m4s）。
    } else {
        // yt-dlp 退出 0 但没定位到产物：只有目录里确实存在完整媒体文件时才保留，
        // 避免误删已下好的视频；纯中间产物一律清理，不再留空壳文件夹。
        if guard.has_complete_media() {
            guard.keep();
            return Err(EngineError::message(
                "下载完成，但未能定位输出文件；视频已保留在下载目录的 fluxdl-<任务id> 子目录，请手动取出",
            ));
        }
        return Err(EngineError::message(
            "下载完成，但未找到本次输出的视频文件；临时目录已清理，请重试或改用浏览器扩展嗅探到的视频直链下载",
        ));
    }
    drop(view);
    Ok(())
}

/// 把独占目录里的最终产物发布回用户选择的下载目录。
///
/// 同名已存在时按 `name (1).ext` 避让；rename 失败时返回原路径，
/// 调用方据此保留独占目录，避免把产物连同目录一起删掉。
fn publish_output(path: &Path, save_dir: &Path) -> PathBuf {
    let Some(name) = path.file_name() else {
        return path.to_path_buf();
    };
    let name = name.to_string_lossy();
    let candidate = save_dir.join(name.as_ref());
    let target = if candidate.exists() {
        let p = Path::new(name.as_ref());
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = p
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        let mut alt = candidate.clone();
        for i in 1..1000 {
            let attempt = save_dir.join(format!("{stem} ({i}){ext}"));
            if !attempt.exists() {
                alt = attempt;
                break;
            }
        }
        alt
    } else {
        candidate
    };
    std::fs::rename(path, &target)
        .map(|_| target)
        .unwrap_or_else(|_| path.to_path_buf())
}

/// 逐行读子进程输出，把进度 / 收尾协议行与错误日志正确分流。
///
/// `aria2_mode` 为 true 时认领 aria2 的 `[#gid ...]` 进度行；为 false（原生模式）
/// 时认领 yt-dlp 自己的 `FLUXDL|...` 进度行。两种模式下 yt-dlp 的 `FLUXDONE|`
/// 收尾行都原样转发，交给 `run()` 解析出最终路径。其余内容按 `ERR|` 上报。
///
/// ## 修复 A：原生模式曾经把所有行都加 `ERR|` 前缀
///
/// 旧实现 `!aria2_mode` 时直接 `spawn_line_reader(.., "ERR|")`，把 yt-dlp 的
/// 进度行 `FLUXDL|...` 裹成 `ERR|FLUXDL|...`。`run()` 用 `strip_prefix("FLUXDL|")`
/// 匹配不上，反被 `strip_prefix("ERR|")` 当成错误日志 —— 于是 UI 全程停在 0% /
/// 未知，进度行还刷满了「最近错误」。现在原生模式只给非协议行加 `ERR|`。
fn spawn_aria2_progress_reader<R>(reader: R, tx: mpsc::UnboundedSender<String>, aria2_mode: bool)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    if !aria2_mode {
        spawn_native_reader(reader, tx);
        return;
    }
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    while let Some(&last) = buf.last() {
                        if last == b'\n' || last == b'\r' {
                            buf.pop();
                        } else {
                            break;
                        }
                    }
                    let line = String::from_utf8_lossy(&buf);
                    // 与 `aria2::spawn_progress_reader` 保持同一套过滤规则：
                    // 装饰行（分隔线、汇总表头）既不转进度也不当报错，否则它们会
                    // 挤进「最近错误」，任务失败时的提示就变成一堆分隔线。
                    if let Some(progress) = aria2::parse_progress_line(&line) {
                        if tx.send(progress).is_err() {
                            break;
                        }
                    } else if line.starts_with("FLUXDONE|") {
                        // yt-dlp 的收尾行：原样转发，否则会被 ERR| 分支吞掉，
                        // 导致收尾拿不到最终路径，只能靠目录差分兜底。
                        if tx.send(line.into_owned()).is_err() {
                            break;
                        }
                    } else if !aria2::is_noise(&line) && tx.send(format!("ERR|{line}")).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// 原生（yt-dlp 直连）模式的输出分发。
///
/// yt-dlp 自己负责「取字节」，进度行格式就是 `FLUXDL|...`、收尾行是 `FLUXDONE|...`，
/// 这两类必须**原样**交给 `run()` 解析；其余的才是需要上报的错误 / 日志。
/// （详见 `spawn_aria2_progress_reader` 顶部关于修复 A 的说明。）
fn spawn_native_reader<R>(reader: R, tx: mpsc::UnboundedSender<String>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf: Vec<u8> = Vec::new();
        let mut last_log = String::new();
        let mut repeated = 0u32;
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    while let Some(&last) = buf.last() {
                        if last == b'\n' || last == b'\r' {
                            buf.pop();
                        } else {
                            break;
                        }
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    if line.starts_with("FLUXDL|") || line.starts_with("FLUXDONE|") {
                        if tx.send(line).is_err() {
                            break;
                        }
                        continue;
                    }
                    // 0.3.4：0.3.3 把 B 站切回原生下载器后，最常用的这条路径
                    // 反而绕过了 is_noise，yt-dlp 的阶段输出全被当 ERR| 灌进
                    // 「最近错误」。这里与 aria2 模式用同一套过滤，并压掉重复行。
                    if aria2::is_noise(&line) || is_ytdlp_routine_line(&line) {
                        continue;
                    }
                    if line == last_log {
                        repeated += 1;
                        if repeated > 2 {
                            continue;
                        }
                    } else {
                        last_log = line.clone();
                        repeated = 0;
                    }
                    if tx.send(format!("ERR|{line}")).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// yt-dlp 的常规阶段输出（合并 / 修复 / 分片提示），不是错误，不该进「最近错误」。
/// 含 ERROR / error: 的行一律保留，避免把真正的失败吞掉。
fn is_ytdlp_routine_line(line: &str) -> bool {
    let t = line.trim_start();
    (t.starts_with("[download]")
        || t.starts_with("[Merger]")
        || t.starts_with("[Fixup]")
        || t.starts_with("[ExtractAudio]")
        || t.starts_with("[info]")
        || t.starts_with("[hlsnative]")
        || t.starts_with("[dashsegments]"))
        && !t.contains("ERROR")
        && !t.contains("error:")
}

/// aria2c 的查找目录：用户显式配置优先，其次 yt-dlp / ffmpeg 所在目录，
/// 最后是随包 tools/ 与 exe 同级目录（便携版布局）。
fn aria2_candidates(options: &EngineOptions) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let push_dir_of = |dirs: &mut Vec<PathBuf>, file: &str| {
        let file = file.trim();
        if file.is_empty() {
            return;
        }
        if let Some(parent) = Path::new(file).parent() {
            if !parent.as_os_str().is_empty() {
                dirs.push(parent.to_path_buf());
            }
        }
    };
    if let Some(explicit) = options.aria2_path.as_deref() {
        // 允许直接给到 exe：父目录 + 文件名一并入列，`locate` 只做 join 判断。
        push_dir_of(&mut dirs, explicit);
        dirs.push(PathBuf::from(explicit));
    }
    push_dir_of(&mut dirs, &options.yt_dlp_path);
    if let Some(ff) = options.ffmpeg_path.as_deref() {
        push_dir_of(&mut dirs, ff);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("tools"));
            dirs.push(parent.to_path_buf());
        }
    }
    #[cfg(debug_assertions)]
    {
        dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools"));
    }
    dirs
}

/// 把 yt-dlp 的英文报错翻译成一句中文可操作指引。
///
/// 0.3.5 修正：0.3.0~0.3.4 的 `Unsupported URL` 提示写着「FluxDL 目前支持
/// B 站、抖音、快手、小红书、微博等国内站点」，与内置 yt-dlp 的实际能力不符
/// ——打包版（2026.10.26，1755 个提取器）里**没有任何快手 / Kwai 提取器**，
/// 抖音网页解析还要求 `s_v_web_id` 匿名校验 cookie，而 FluxDL 不读取、不传输、
/// 不落盘任何凭证。用户照着那句提示反复重试只会一直失败（真机截图已复现）。
/// 现在按「站点 + 错误类型」分别给出真正可行的下一步，不再列举虚假支持名单。
fn failure_hint(errors: &[String], url: &str) -> &'static str {
    let host = host_of(url);
    let is_kuaishou = host == "kuaishou.com"
        || host.ends_with(".kuaishou.com")
        || host == "kwai.com"
        || host.ends_with(".kwai.com");
    // 快手网页链接：内置解析器根本没有该站点提取器，改参数也解析不出来。
    // 唯一可行的路径是扩展嗅探到的 CDN 视频直链（普通下载任务）。
    if is_kuaishou {
        return "（内置视频解析器不支持快手的网页链接。请在浏览器扩展弹窗的资源列表里选择嗅探到的视频直链，用普通下载；或把该视频的直链地址粘贴到新建任务。首页 / 发现页不能整页解析）";
    }

    // 抖音等站点要求浏览器下发的匿名校验 cookie 才能解析网页，FluxDL 明确
    // 不碰任何凭证，这条路径在本产品里是关闭的，得如实说清楚并给出替代方案。
    let needs_cookie = errors.iter().any(|e| {
        e.contains("Fresh cookies")
            || e.contains("s_v_web_id")
            || e.contains("not necessarily logged in")
    });
    if needs_cookie {
        return "（该站点要求浏览器下发的匿名校验 cookie 才能解析网页；FluxDL 不读取、传输或保存任何登录凭证，因此不解析这类页面。请在浏览器扩展弹窗的资源列表里选择该视频的直链，用普通下载）";
    }

    let unsupported = errors.iter().any(|e| {
        e.contains("Unsupported URL")
            || e.contains("is not a valid URL")
            || e.contains("No video formats found")
    });
    if unsupported {
        return "（这个链接不是单个视频的详情页——站点首页、发现页、精选页、合集页都无法解析。请打开要下载的那个视频、复制它的详情页链接重试；抖音「精选 / 推荐」页链接已自动归一化。仍不行时请用浏览器扩展资源列表里嗅探到的视频直链做普通下载）";
    }
    let need_login = errors.iter().any(|e| {
        e.contains("login")
            || e.contains("Sign in")
            || e.contains("Premium")
            || e.contains("会员")
            || e.contains("DRM")
    });
    if need_login {
        return "（该内容需要登录或会员权限，FluxDL 不保存任何账号凭证，请改用普通下载任务或换可用来源）";
    }
    ""
}

/// 记录目录里现有文件的大小 / 修改时间，用于下载后做差分。
fn snapshot_files(dir: &Path) -> HashMap<PathBuf, (u64, SystemTime)> {
    let mut out = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if let Ok(meta) = e.metadata() {
                if meta.is_file() {
                    out.insert(
                        e.path(),
                        (meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)),
                    );
                }
            }
        }
    }
    out
}

/// 找出本次运行新增（或被改写）的产物，排除 yt-dlp 的中间文件。
///
/// 这层兜底专门处理「FLUXDONE 路径不可解析」的情况：Windows 中文系统下
/// `--print after_move` 可能吐 GBK 字节，lossy 解码后路径不存在，旧实现会
/// 把一次成功下载误判成「未找到输出的视频文件」。
fn find_new_output(dir: &Path, before: &HashMap<PathBuf, (u64, SystemTime)>) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let path = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        if name.ends_with(".part")
            || name.ends_with(".ytdl")
            || name.ends_with(".fluxdl-part")
            || name.ends_with(".tmp")
        {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let changed = match before.get(&path) {
            None => true,
            Some((size, old_mtime)) => *size != meta.len() || modified > *old_mtime,
        };
        if !changed {
            continue;
        }
        if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, p)| p)
}

/// 媒体扩展名白名单：默认名场景下只认这些，避免误认领目录里无关的最新文件。
fn is_media_ext(lower: &str) -> bool {
    const EXTS: [&str; 12] = [
        ".mp4", ".mkv", ".webm", ".flv", ".mov", ".avi", ".ts", ".m4a", ".mp3", ".aac", ".opus",
        ".wav",
    ];
    EXTS.iter().any(|e| lower.ends_with(e))
}

fn find_output(dir: &Path, placeholder: &str) -> Option<PathBuf> {
    let stem = Path::new(placeholder)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // 默认名（"video" / "video (1)" / "video (2)"…）来自 NewTaskOptions 未指定文件名，
    // 与 yt-dlp 的真实产物名（`%(title).150B [%(id)s].%(ext)s`）毫无关系。
    //
    // 旧实现只认 `stem == "video"`：一旦默认名被 `unique_path_reserved` 唯一化成
    // "video (1)"（下载目录里已存在 video / video.fluxdl-part 时必然发生），
    // 这里就再也匹配不上任何真实文件。叠加 yt-dlp 对「目标已存在」会直接跳过下载
    // （退出码 0、不触发 after_move、不打 FLUXDONE），`find_new_output` 又因文件
    // 大小/mtime 未变化而落空 —— 最终把一次「文件已在本地」误报成
    // 「下载完成，但未找到输出的视频文件」。
    let generic = stem.is_empty() || stem == "video" || stem.starts_with("video (");
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".part")
            || lower.ends_with(".ytdl")
            || lower.ends_with(".fluxdl-part")
            || lower.ends_with(".tmp")
        {
            continue;
        }
        let matches = if generic {
            // 默认名场景：认领目录内最新的媒体文件（含本次之前就存在的），
            // 以覆盖「重试同一视频、yt-dlp 跳过下载」这一最常见分支。
            is_media_ext(&lower)
        } else {
            name.contains(&stem)
        };
        if !matches {
            continue;
        }
        if let Ok(modified) = meta.modified() {
            if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                best = Some((modified, path));
            }
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncWriteExt};

    /// 真机截图里的乱码标题（`yt-dlp.exe` stdout 按 ANSI 代码页输出后被 Latin-1 解读）。
    /// 这类串绝不能回填到任务标题，否则用户看到的比默认名 `video (1)` 还糟。
    #[test]
    fn looks_mojibake_rejects_real_world_garbled_title() {
        assert!(looks_mojibake("4K|⯃ÜŨ♦GGotBBang♦"));
        assert!(looks_mojibake("â€œNever Gonna Give You Upâ€"));
        assert!(looks_mojibake("\u{FFFD}\u{FFFD}\u{FFFD}"));
    }

    /// 正常中文 / 日文 / 带符号标题不能误判，否则合法标题会被丢掉退回默认名。
    /// 0.3.3 的「非 CJK 占比」规则把下面前四组全部误杀过，这里是回归保护。
    #[test]
    fn looks_mojibake_accepts_normal_titles() {
        assert!(!looks_mojibake("【4K】GGotBBang 官方MV"));
        assert!(!looks_mojibake("Never Gonna Give You Up (Official Video)"));
        assert!(!looks_mojibake("★ 日语标题 ♪ テスト"));
        assert!(!looks_mojibake("SÃO PAULO 4K"));
        assert!(!looks_mojibake("Привет мир 2025"));
        assert!(!looks_mojibake("สวัสดีครับ"));
        assert!(!looks_mojibake("Tiếng Việt Official MV"));
        assert!(!looks_mojibake("Best 🔥🔥🔥 4K"));
        assert!(!looks_mojibake(""));
    }

    /// B 站 DASH 分片流必须交回 yt-dlp 原生下载器：碎片只有 100 KB 级，
    /// aria2 的 `-k4M` 永不切分，只会恒用 1 条连接（真机 `CN:1`）并多起进程。
    /// 整文件直链站点则仍应交给 aria2 拿多连接。
    #[test]
    fn aria2_suits_url_excludes_bilibili_only() {
        assert!(!aria2_suits_url("https://www.bilibili.com/video/BV1GysQ6hEgB"));
        assert!(!aria2_suits_url("https://b23.tv/abcdefg"));
        assert!(aria2_suits_url("https://example.com/big.iso"));
        assert!(aria2_suits_url("https://cdn.example.org/a/b/c.zip?x=1"));
    }

    async fn collect(bytes: &[u8], prefix: &'static str) -> Vec<String> {
        let (mut writer, reader) = duplex(1024);
        let owned = bytes.to_vec();
        tokio::spawn(async move {
            writer.write_all(&owned).await.unwrap();
            drop(writer); // 关闭写端 => 读端收到 EOF
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        spawn_line_reader(reader, tx, prefix);
        let mut out = Vec::new();
        while let Some(line) = rx.recv().await {
            out.push(line);
        }
        out
    }

    /// 复现 Windows GBK 输出场景：一行里含非法 UTF-8 字节，
    /// 旧实现会在此退出并丢掉后续所有行（ yt-dlp 随即 EINVAL(22) 崩溃）。
    #[tokio::test]
    async fn invalid_utf8_does_not_stop_the_reader() {
        let lines = collect(
            b"download:FLUXDL|1|2|0|0|0|video-\xff\xfe.mp4\nFLUXDONE|/tmp/ok.mp4\n",
            "",
        )
        .await;
        assert_eq!(lines.len(), 2, "非法 UTF-8 之后的行必须继续被读到");
        assert!(lines[0].starts_with("download:FLUXDL|"));
        assert!(lines[1].starts_with("FLUXDONE|"));
    }

    #[tokio::test]
    async fn stderr_lines_keep_prefix_and_empty_lines() {
        let lines = collect(b"ERROR: bad\n\nWARNING: slow\n", "ERR|").await;
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "ERR|ERROR: bad");
        assert_eq!(lines[1], "ERR|");
        assert_eq!(lines[2], "ERR|WARNING: slow");
    }

    #[tokio::test]
    async fn crlf_and_last_line_without_newline() {
        let lines = collect(b"one\r\ntwo", "").await;
        assert_eq!(lines, vec!["one".to_string(), "two".to_string()]);
    }

    /// FLUXDONE 路径是乱码时，靠目录差分仍能找到中文名产物，且忽略 .part 中间文件。
    #[tokio::test]
    async fn directory_diff_finds_output_with_mojibake_path() {
        let dir = tempfile::tempdir().unwrap();
        let before = snapshot_files(dir.path());
        std::fs::write(dir.path().join("中文标题 [abc].mp4"), b"video-data").unwrap();
        std::fs::write(dir.path().join("正在下载.part"), b"partial").unwrap();
        let found = find_new_output(dir.path(), &before).unwrap();
        assert_eq!(found.file_name().unwrap(), "中文标题 [abc].mp4");
    }

    #[tokio::test]
    async fn directory_diff_ignores_untouched_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("older.mp4"), b"old").unwrap();
        let before = snapshot_files(dir.path());
        assert!(find_new_output(dir.path(), &before).is_none());
    }

    /// 回归：默认名被唯一化成 "video (1)" 后，仍要能认领目录里真实标题的产物。
    ///
    /// 旧实现 `stem == "video"` 对 "video (1)" 恒为假，导致「重试同一视频、
    /// yt-dlp 判定文件已存在而跳过下载」被误报成「下载完成，但未找到输出文件」。
    #[test]
    fn find_output_accepts_media_when_placeholder_is_deduped_default() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("【某视频标题】 [BV1GysQ6hEgB].mp4");
        std::fs::write(&real, b"video-data").unwrap();
        let found = find_output(dir.path(), "video (1)").expect("应兜底认领真实产物");
        assert_eq!(found, real);
    }

    /// 默认名场景下不能把目录里无关的最新文件（日志、说明）当成视频产物。
    #[test]
    fn find_output_ignores_non_media_for_generic_placeholder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("日志.txt"), b"log").unwrap();
        std::fs::write(dir.path().join("aaa.log"), b"log").unwrap();
        assert!(
            find_output(dir.path(), "video").is_none(),
            "非媒体文件不应被认领"
        );
    }

    /// 显式文件名（非默认名）仍按名字匹配，不走媒体扩展名兜底。
    #[test]
    fn find_output_matches_explicit_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("report.bin"), b"data").unwrap();
        let found = find_output(dir.path(), "report.bin").expect("显式名应命中");
        assert_eq!(found.file_name().unwrap(), "report.bin");
    }

    #[test]
    fn default_format_prefers_video_plus_audio() {
        assert_eq!(DEFAULT_FORMAT, "bv*+ba/b");
        // 0.3.0 起不再有「放宽到 worst」的降级链
        assert!(!DEFAULT_FORMAT.contains("worst"));
    }

    #[test]
    fn concurrent_fragments_is_multiple_but_bounded() {
        assert!(CONCURRENT_FRAGMENTS >= 2, "并发至少 2 路才有意义");
        assert!(CONCURRENT_FRAGMENTS <= 8, "过高容易触发站点风控");
    }

    #[test]
    fn bilibili_detection_covers_short_link() {
        assert!(is_bilibili("https://www.bilibili.com/video/BV1xx"));
        assert!(is_bilibili("https://bilibili.com/video/BV1xx"));
        assert!(is_bilibili("https://b23.tv/abcd"));
        assert!(is_bilibili("http://m.bilibili.com/video/BV1xx?p=2"));
        assert!(!is_bilibili("https://www.douyin.com/video/1"));
        // 不能把「域名里碰巧含 b23.tv」的其它站点也算进来
        assert!(!is_bilibili("https://example.com/b23.tv-x"));
        assert!(!is_bilibili("https://notbilibili.com/x"));
        // 主机名比较要能穿透 userinfo 与端口
        assert!(is_bilibili("https://user:pw@b23.tv:443/abcd"));
    }

    #[test]
    fn unsupported_url_gets_actionable_hint() {
        let hint = failure_hint(
            &["ERROR: Unsupported URL: https://example.com".into()],
            "https://example.com",
        );
        assert!(hint.contains("详情页"));
        assert!(hint.contains("普通下载"));
        // 0.3.5：不再宣称「支持 B 站、抖音、快手…」这类与内置解析器能力不符的名单
        assert!(!hint.contains("支持 B 站"));
    }

    #[test]
    fn login_error_gets_credential_free_hint() {
        let hint = failure_hint(
            &["ERROR: This video requires login".into()],
            "https://example.com",
        );
        assert!(hint.contains("不保存任何账号凭证"));
    }

    #[test]
    fn unknown_error_has_no_hint() {
        assert_eq!(
            failure_hint(&["ERROR: 404 Not Found".into()], "https://example.com"),
            ""
        );
    }

    /// 0.3.5：抖音「精选 / 推荐 / 主页」带 modal_id 的聚合页必须归一化成
    /// yt-dlp 唯一认识的 /video/<id>；其它站点 / 已是详情页 / 非法 id 原样返回。
    #[test]
    fn douyin_modal_id_urls_are_normalized_to_video_page() {
        assert_eq!(
            normalize_media_url("https://www.douyin.com/jingxuan?modal_id=7702008165390421263"),
            "https://www.douyin.com/video/7702008165390421263"
        );
        assert_eq!(
            normalize_media_url("https://www.douyin.com/user/MS4wLjABAAAA?modal_id=1234567890"),
            "https://www.douyin.com/video/1234567890"
        );
        assert_eq!(
            normalize_media_url("https://www.douyin.com/discover?modal_id=123&from=tab"),
            "https://www.douyin.com/video/123"
        );
        assert_eq!(
            normalize_media_url("https://v.douyin.com/iRabcdef/?modal_id=9988"),
            "https://www.douyin.com/video/9988"
        );
        // 已是详情页：原样
        assert_eq!(
            normalize_media_url("https://www.douyin.com/video/7702008165390421263"),
            "https://www.douyin.com/video/7702008165390421263"
        );
        // 非纯数字 / 无 modal_id / 非抖音：原样
        assert_eq!(
            normalize_media_url("https://www.douyin.com/jingxuan?modal_id=abc"),
            "https://www.douyin.com/jingxuan?modal_id=abc"
        );
        assert_eq!(
            normalize_media_url("https://www.douyin.com/jingxuan"),
            "https://www.douyin.com/jingxuan"
        );
        assert_eq!(
            normalize_media_url("https://www.kuaishou.com/new-reco?modal_id=123"),
            "https://www.kuaishou.com/new-reco?modal_id=123"
        );
        assert_eq!(
            normalize_media_url("https://example.com/bilibili.com-x/video.mp4?modal_id=9"),
            "https://example.com/bilibili.com-x/video.mp4?modal_id=9"
        );
    }

    /// 0.3.5：CDN 容器直链必须短路成 HTTP 普通下载，不能因主机名命中站点名单
    /// 被误建成 Media 任务（会报 Unsupported URL）；分片清单不短路。
    #[test]
    fn direct_container_files_are_detected_without_catching_fragments() {
        for url in [
            "https://v2.kuaishou.com/abc.mp4",
            "https://cdn.douyin.com/x/y.mp4?token=deadbeef",
            "https://example.com/a.mkv#t=10",
            "https://example.com/a.MP4",
            "https://example.com/song.mp3",
        ] {
            assert!(is_direct_media_file(url), "完整容器直链应短路：{url}");
        }
        for url in [
            "https://www.bilibili.com/video/BV1xx",
            "https://v2.kuaishou.com/seg-1.m4s",
            "https://cdn.example.com/index.m3u8?token=x",
            "https://cdn.example.com/manifest.mpd",
            "https://example.com/bilibili.com-x/video.mp4.zip",
        ] {
            assert!(!is_direct_media_file(url), "分片 / 页面 / 其它扩展不应短路：{url}");
        }
    }

    /// 0.3.5：失败提示按站点分流，不再宣称「支持快手」这类与内置解析器
    /// 实际能力不符的名单，且明确说明不碰凭证。
    #[test]
    fn failure_hints_are_site_aware_and_credential_free() {
        let ks = failure_hint(
            &["ERROR: Unsupported URL: https://www.kuaishou.com/new-reco".into()],
            "https://www.kuaishou.com/new-reco",
        );
        assert!(ks.contains("不支持快手的网页链接"));
        assert!(ks.contains("资源列表"));

        let cookie = failure_hint(
            &["ERROR: Fresh cookies (not necessarily logged in) are needed".into()],
            "https://www.douyin.com/video/123",
        );
        assert!(cookie.contains("不读取、传输或保存任何登录凭证"));

        let unsupported = failure_hint(
            &["ERROR: Unsupported URL: https://example.com/x".into()],
            "https://example.com/x",
        );
        assert!(unsupported.contains("详情页"));
        assert!(!unsupported.contains("支持 B 站、抖音、快手"));

        assert_eq!(
            failure_hint(&["ERROR: 404 Not Found".into()], "https://example.com/x"),
            ""
        );
    }

    /// 0.3.6：页面 URL 不等于视频文件。真机截图里快手 / 抖音网页链接被建成
    /// 必然失败的 Media 任务（Unsupported URL / Fresh cookies），这里把
    /// 「建任务前拒绝」钉成红线；容器直链与正常详情页必须放行。
    #[test]
    fn media_page_blocker_rejects_unparsable_pages_but_allows_direct_files() {
        for url in [
            "https://www.kuaishou.com/new-reco",
            "https://www.kuaishou.com/short-video/3xabc",
            "https://v.kuaishou.com/abc",
            "https://www.douyin.com/video/7702008165390421263",
            "https://www.douyin.com/jingxuan?modal_id=7702008165390421263",
            "https://www.douyin.com/jingxuan",
            "https://www.bilibili.com/",
            "https://www.bilibili.com/index",
        ] {
            assert!(
                media_page_blocker(url).is_some(),
                "应提前拦截，不要创建必然失败的 Media 任务：{url}"
            );
        }
        for url in [
            "https://www.bilibili.com/video/BV1GysQ6hEgB",
            "https://b23.tv/abcd",
            "https://v2.kuaishou.com/abc.mp4",
            "https://cdn.douyin.com/x/y.mp4?token=1",
            "https://example.com/video.mp4",
            "https://example.com/article/123",
            "https://www.youtube.com/watch?v=abcdefghijk",
        ] {
            assert_eq!(media_page_blocker(url), None, "不应误拦：{url}");
        }
        let hint = media_page_blocker("https://www.kuaishou.com/new-reco").unwrap();
        assert!(hint.contains("本页资源"), "提示必须给出可操作路径：{hint}");
        assert!(!hint.contains("支持快手"), "不得再宣称支持快手整页解析");
    }

    /// 0.3.6：目录守卫覆盖所有退出路径。未 keep 时 Drop 删掉整个目录
    /// （含 .part / .ytdl / 分片），keep 时保留完整产物不被误删。
    #[test]
    fn work_dir_guard_cleans_up_unless_kept() {
        let tmp = tempfile::tempdir().unwrap();

        let dropped = tmp.path().join("fluxdl-deadbeef");
        std::fs::create_dir_all(&dropped).unwrap();
        std::fs::write(dropped.join("out.mp4.part"), b"partial").unwrap();
        std::fs::write(dropped.join("seg-1.m4s"), b"fragment").unwrap();
        {
            let _guard = WorkDirGuard::new(dropped.clone());
            assert!(dropped.exists());
        }
        assert!(!dropped.exists(), "失败 / 暂停退出时目录必须被自动清理");

        let kept = tmp.path().join("fluxdl-12345678");
        std::fs::create_dir_all(&kept).unwrap();
        std::fs::write(kept.join("real-video.mp4"), b"complete").unwrap();
        {
            let mut guard = WorkDirGuard::new(kept.clone());
            assert!(guard.has_complete_media());
            guard.keep();
        }
        assert!(kept.exists(), "keep 后必须保留目录里的完整视频");
        assert!(kept.join("real-video.mp4").exists());
    }

    /// 只有中间态文件时不算「完整媒体」，不能因此把垃圾目录留下来。
    #[test]
    fn work_dir_guard_ignores_partial_files() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("fluxdl-abcdef12");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("out.mp4.part"), b"partial").unwrap();
        std::fs::write(work.join("out.mp4.ytdl"), b"meta").unwrap();
        std::fs::write(work.join("seg-1.m4s.tmp"), b"fragment").unwrap();
        let guard = WorkDirGuard::new(work.clone());
        assert!(!guard.has_complete_media(), "中间态文件不应被当成已下好的视频");
        drop(guard);
        assert!(!work.exists());
    }

    /// 回归（修复 A）：原生（非 aria2）模式必须把 `FLUXDL|` / `FLUXDONE|` 当协议行
    /// 原样转发，绝不能裹上 `ERR|` —— 旧实现 `spawn_line_reader(.., "ERR|")` 会把进度行
    /// 变成 `ERR|FLUXDL|...`，run() 的 `strip_prefix("FLUXDL|")` 匹配不上，进度被当成
    /// 错误日志，UI 全程停在 0% / 未知。
    #[tokio::test]
    async fn native_reader_forwards_progress_without_err_prefix() {
        let payload = b"FLUXDL|100|200|200|1024|1|t.mp4\nFLUXDONE|/tmp/t.mp4\nsome yt-dlp log line\n";
        let (mut w, r) = duplex(2048);
        let owned = payload.to_vec();
        tokio::spawn(async move {
            w.write_all(&owned).await.unwrap();
            drop(w);
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        spawn_native_reader(r, tx);
        let mut lines = Vec::new();
        while let Some(l) = rx.recv().await {
            lines.push(l);
        }
        assert_eq!(lines.len(), 3, "三行都应被转发：{lines:?}");
        assert!(lines[0].starts_with("FLUXDL|"), "进度行必须原样，不能被 ERR| 包裹：{lines:?}");
        assert!(lines[1].starts_with("FLUXDONE|"), "收尾行必须原样：{lines:?}");
        assert!(lines[2].starts_with("ERR|"), "普通日志行应加 ERR| 前缀：{lines:?}");
    }
}
