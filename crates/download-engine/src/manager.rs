use crate::http;
use crate::limit::RateLimiter;
use crate::media;
use crate::store::{self, PersistedTask, StoreFile};
use crate::types::*;
use crate::util;
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex as AsyncMutex, Notify};
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("网络错误：{0}")]
    Http(#[from] reqwest::Error),
    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
    #[error("已暂停")]
    Paused,
}

impl EngineError {
    pub fn message(msg: impl Into<String>) -> Self {
        Self::Message(msg.into())
    }
}

fn download_category(kind: TaskKind, filename: &str) -> &'static str {
    if kind == TaskKind::Media {
        return "视频";
    }
    let extension = filename
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "mp4" | "mkv" | "mov" | "avi" | "webm" | "flv" | "wmv" | "m4v" | "ts"
        | "m3u8" | "mpd" => "视频",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf"
        | "epub" | "mobi" | "md" => "文档",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "dmg" => "压缩包",
        _ => "其他",
    }
}

#[derive(Default)]
pub(crate) struct Sample {
    pub bytes: u64,
    pub at: Option<Instant>,
    pub speed: u64,
}

pub struct TaskEntry {
    pub id: String,
    pub kind: TaskKind,
    pub url: String,
    pub user_agent: String,
    pub proxy: Option<String>,
    pub view: AsyncMutex<TaskView>,
    pub options: NewTaskOptions,
    pub cancel: AsyncMutex<Option<CancellationToken>>,
    pub downloaded: AtomicU64,
    pub segments: Mutex<Vec<SegmentView>>,
    pub limiter: RateLimiter,
    pub wanted_pause: AtomicBool,
    pub finished: AtomicBool,
    pub(crate) sample: Mutex<Sample>,
}

pub struct Engine {
    tasks: RwLock<HashMap<String, Arc<TaskEntry>>>,
    order: Mutex<Vec<String>>,
    options: RwLock<EngineOptions>,
    store_path: PathBuf,
    recovered_tasks: bool,
    events: mpsc::UnboundedSender<EngineEvent>,
    global_limiter: Arc<RateLimiter>,
    /// 阶段一 #5：每主机连接数学习表（AIMD）。仅内存态，重启后重新学习，
    /// 用 parking_lot 同步锁，读/反馈都不跨 await。
    host_limits: Mutex<crate::host_limit::HostLimits>,
    active: Mutex<usize>,
    notify: Notify,
    ticks: AtomicU64,
    /// P0-1 修复：已分配给任务的目标路径。unique_path 只判断最终文件是否存在，
    /// 而写入用的是 `{save_path}.fluxdl-part`，在 part 创建前存在竞态窗口，
    /// 多个任务可能拿到同一个路径并交错写同一文件。这里做进程内占位。
    reserved: Mutex<std::collections::HashSet<PathBuf>>,
    /// P1-5 修复：持久化写入串行化。store::save 用固定 tmp + rename，
    /// 并发调用会互相踩 tmp，甚至把目标删掉却没改名回来。
    save_lock: AsyncMutex<()>,
}

struct SlotGuard {
    engine: Arc<Engine>,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        let mut active = self.engine.active.lock();
        *active = active.saturating_sub(1);
        drop(active);
        self.engine.notify.notify_waiters();
    }
}

impl Engine {
    pub fn new(store_path: PathBuf, events: mpsc::UnboundedSender<EngineEvent>) -> Arc<Self> {
        let (stored, recovered_tasks) = store::load(&store_path);
        let options = stored.options.clone().unwrap_or_default();
        let global_limiter = Arc::new(RateLimiter::new(options.global_speed_limit));

        let mut map = HashMap::new();
        let mut order = Vec::new();
        for p in stored.tasks {
            let id = p.view.id.clone();
            let downloaded = p.view.downloaded_bytes;
            let entry = Arc::new(TaskEntry {
                id: id.clone(),
                kind: p.view.kind,
                url: p.view.url.clone(),
                user_agent: p
                    .view
                    .user_agent
                    .clone()
                    .unwrap_or_else(|| options.user_agent.clone()),
                proxy: p.view.proxy.clone().or_else(|| options.proxy.clone()),
                view: AsyncMutex::new(p.view),
                options: p.options,
                cancel: AsyncMutex::new(None),
                downloaded: AtomicU64::new(downloaded),
                segments: Mutex::new(Vec::new()),
                limiter: RateLimiter::new(None),
                wanted_pause: AtomicBool::new(false),
                finished: AtomicBool::new(false),
                sample: Mutex::new(Sample::default()),
            });
            order.push(id.clone());
            map.insert(id, entry);
        }

        let engine = Arc::new(Self {
            tasks: RwLock::new(map),
            order: Mutex::new(order),
            options: RwLock::new(options),
            store_path,
            recovered_tasks,
            events,
            global_limiter,
            host_limits: Mutex::new(crate::host_limit::HostLimits::new()),
            active: Mutex::new(0),
            notify: Notify::new(),
            ticks: AtomicU64::new(0),
            reserved: Mutex::new(std::collections::HashSet::new()),
            save_lock: AsyncMutex::new(()),
        });

        // Hydrate segment lists + rate limiters from the persisted views.
        {
            let map = engine.tasks.read();
            let mut reserved = engine.reserved.lock();
            for entry in map.values() {
                let view = entry.view.try_lock();
                if let Ok(view) = view {
                    *entry.segments.lock() = view.segments.clone();
                    entry.limiter.set_limit(view.speed_limit);
                    entry
                        .downloaded
                        .store(view.downloaded_bytes, Ordering::Relaxed);
                    // P0-1 修复（重启路径）：恢复的任务其目标路径同样要占位。
                    // 否则重启后 part 尚未创建时，新任务可能拿到同一个 save_path。
                    reserved.insert(PathBuf::from(&view.save_path));
                }
            }
        }

        let weak = Arc::downgrade(&engine);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(500));
            loop {
                ticker.tick().await;
                let Some(engine) = weak.upgrade() else { break };
                engine.trigger_due_schedules().await;
                engine.tick().await;
            }
        });

        engine
    }

    pub fn options(&self) -> EngineOptions {
        self.options.read().clone()
    }

    /// 阶段一 #5：按主机学习到的上限，给出本次建议连接数。
    /// `requested` 是体积自适应后的目标连接数；无失败记录时原样返回。
    pub(crate) fn suggest_connections(&self, url: &str, requested: usize) -> usize {
        self.host_limits.lock().suggest(url, requested)
    }

    /// 阶段一 #5：反馈主机压力，返回降级后的上限（便于写日志）。
    pub(crate) fn note_host_failure(
        &self,
        url: &str,
        kind: crate::host_limit::FailureKind,
    ) -> usize {
        let ceiling = self.host_limits.lock().on_failure(url, kind);
        if ceiling < crate::host_limit::DEFAULT_CEILING {
            let key = crate::host_limit::HostLimits::host_key(url);
            let _ = self.events.send(EngineEvent::Log(LogLine {
                task_id: String::new(),
                message: format!(
                    "主机 {key} 连接受限，并发上限收敛到 {ceiling}（避免被服务器封禁）"
                ),
                at: chrono::Utc::now().timestamp_millis(),
            }));
        }
        ceiling
    }

    /// 阶段一 #5：反馈一次成功传输，缓慢回升主机上限。
    pub(crate) fn note_host_success(&self, url: &str) {
        self.host_limits.lock().on_success(url);
    }

    /// 自动更新随包内置的 yt-dlp。报错路径里 `force=true` 会绕过 24h 冷却立即检查。
    /// 返回的结果决定媒体任务是否值得重试一次。
    pub async fn update_ytdlp(&self, force: bool) -> crate::ytdlp::UpdateResult {
        let opts = self.options();
        crate::ytdlp::update_if_stale(&opts.yt_dlp_path, opts.auto_update_yt_dlp, force).await
    }

    pub async fn set_options(self: &Arc<Self>, next: EngineOptions) {
        let global = next.global_speed_limit;
        *self.options.write() = next;
        self.global_limiter.set_limit(global);
        self.notify.notify_waiters();
        self.save().await;
    }

    pub fn subscribe(&self) -> mpsc::UnboundedSender<EngineEvent> {
        self.events.clone()
    }

    pub fn store_path(&self) -> &PathBuf {
        &self.store_path
    }

    pub fn recovered_tasks(&self) -> bool {
        self.recovered_tasks
    }

    pub(crate) fn global_limit(&self) -> Arc<RateLimiter> {
        self.global_limiter.clone()
    }

    fn emit(&self, event: EngineEvent) {
        let _ = self.events.send(event);
    }

    pub(crate) async fn emit_task(&self, entry: &TaskEntry) {
        let view = entry.view.lock().await.clone();
        self.emit(EngineEvent::Task(view));
    }

    pub(crate) fn emit_log(&self, task_id: &str, message: impl Into<String>) {
        self.emit(EngineEvent::Log(LogLine {
            task_id: task_id.to_string(),
            message: message.into(),
            at: chrono::Utc::now().timestamp_millis(),
        }));
    }

    fn get(&self, id: &str) -> Option<Arc<TaskEntry>> {
        self.tasks.read().get(id).cloned()
    }

    fn has(&self, id: &str) -> bool {
        self.tasks.read().contains_key(id)
    }

    pub async fn tasks(&self) -> Vec<TaskView> {
        let order = self.order.lock().clone();
        let mut out = Vec::with_capacity(order.len());
        for id in order.iter().rev() {
            if let Some(entry) = self.get(id) {
                let view = entry.view.lock().await.clone();
                out.push(view);
            }
        }
        out
    }

    pub async fn get_task(&self, id: &str) -> Option<TaskView> {
        match self.get(id) {
            Some(entry) => Some(entry.view.lock().await.clone()),
            None => None,
        }
    }

    pub async fn add(
        self: &Arc<Self>,
        kind: TaskKind,
        raw_url: &str,
        options: NewTaskOptions,
    ) -> Result<TaskView, EngineError> {
        let mut kind = kind;
        let mut raw = raw_url.trim().to_string();
        let mut options = options;
        let mut url = url::Url::parse(&raw)
            .map_err(|_| EngineError::message("链接格式不正确"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(EngineError::message("仅支持 http / https 链接"));
        }
        // 页面 URL 不等于视频文件。对已证实无法整页解析的站点 / 聚合页，
        // 在建任务时就给出可操作指引，不创建必然失败的媒体任务。
        if kind == TaskKind::Media {
            if let Some(hint) = crate::media::media_page_blocker(&raw) {
                return Err(EngineError::message(hint));
            }
        }

        let engine_options = self.options.read().clone();

        // 抖音作品页：走免 Cookie 移动端详情接口解析出无水印直链，转成普通 HTTP
        // 任务交给 A 档引擎（分片 / 校验 / 限速 / 断点续传全部复用）。
        //
        // PC Web 详情接口在 Argus 网关后，缺 a_bogus / uifid 一律 403；随包
        // yt-dlp 的 Douyin 提取器生成不了这些签名，Cookie 也救不了（0.3.9 B 档
        // 真机失败的根因）。所以抖音页面不再交给 yt-dlp，B 站等其它站点仍照旧。
        // 解析失败时直接返回可操作指引，不创建必然失败的任务。
        if kind == TaskKind::Media && crate::douyin::is_douyin_page(&raw) {
            let video = crate::douyin::resolve(&raw, engine_options.proxy.as_deref())
                .await
                .map_err(EngineError::message)?;
            kind = TaskKind::Http;
            raw = video.url.clone();
            url = url::Url::parse(&raw)
                .map_err(|_| EngineError::message("解析出的视频直链格式不正确"))?;
            // 抖音 CDN 校验来源页，缺 Referer 会 403。
            if options
                .referer
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                options.referer = Some(crate::douyin::REFERER.to_string());
            }
            if options
                .user_agent
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                options.user_agent = Some(crate::douyin::DOWNLOAD_UA.to_string());
            }
            if options
                .filename
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                options.filename = Some(video.suggested_filename());
            }
            // 中文建议名来自解析结果，别让 CDN 的 Content-Disposition 覆盖掉。
            options.prefer_header_filename = false;
        }

        let save_dir = options
            .save_dir
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| engine_options.save_dir.clone());
        let filename = options
            .filename
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(|s| util::sanitize_filename(&s))
            .or_else(|| util::filename_from_url(&url))
            .unwrap_or_else(|| {
                if kind == TaskKind::Media {
                    "video".into()
                } else {
                    "download.bin".into()
                }
            });
        let dir = PathBuf::from(&save_dir);
        let dir = if engine_options.organize_by_category {
            dir.join(download_category(kind, &filename))
        } else {
            dir
        };
        if kind == TaskKind::Http {
            util::ensure_dir(&dir)?;
        }
        // P0-1 修复：分配路径时在同一把锁内占位，避免并发 add 撞到同一个目标。
        let save_path = {
            let mut reserved = self.reserved.lock();
            let candidate = util::unique_path_reserved(&dir, &filename, &reserved);
            reserved.insert(candidate.clone());
            candidate
        };
        // 0 = 自动档：由 http.rs 按文件体积收敛实际连接数；1-32 = 用户显式值，完全尊重。
        let connections = options
            .connections
            .unwrap_or(engine_options.connections)
            .clamp(0, 32);
        let speed_limit = options.speed_limit.filter(|v| *v > 0);
        // 默认值修正：`NewTaskOptions` 是 `#[derive(Default)]`，bool 字段默认 false，
        // 而不带 `#[serde(default)]` 的字段在反序列化时同样落到 bool 默认值。
        // 于是「未显式赋值」和「显式关闭」无法区分。aria2c 走的是外部进程，
        // 引擎的 `RateLimiter` 管不到它，所以这里按「是否限速」做一次确定性裁决：
        //   · 全局限速开启 → 一律关闭 aria2c（否则全局限速被绕过）
        //   · 任务限速开启 → 关闭 aria2c
        //   · 两者都没有   → 开启 aria2c（多连接提速）
        // 调用方显式要求 aria2 时尊重它（回归测试 / 高级入口仍可验证该路径）。
        let aria2_explicitly_on = options.aria2;
        // 任务级没显式开 aria2 时，若全局已配置 aria2c 且二进制可探测到、且未限速，
        // 默认开启 aria2 外部下载器（多连接提速）。此前前端从不传 aria2 开关，
        // 导致即使配了 aria2c.exe，真实网页 / 桌面入口也永远走原生模式，加速形同虚设。
        if !options.aria2 {
            let can_accelerate = speed_limit.is_none()
                && engine_options.global_speed_limit.filter(|v| *v > 0).is_none()
                && Self::aria2_available(&engine_options);
            options.aria2 = can_accelerate;
        }
        // 媒体页面一律交回 yt-dlp 原生下载器：DASH / HLS 分片普遍只有 100 KB 级，
        // 远小于 aria2 的 -k4M 切分阈值，aria2 不会切分、恒用 1 条连接（CN:1），
        // 还要为每一片多起一个进程。分片之间的并发由 --concurrent-fragments 负责。
        // 这里只收回「自动开启」的那部分，不覆盖调用方显式开启的选择。
        if kind == TaskKind::Media && !aria2_explicitly_on {
            options.aria2 = false;
        }
        let domain = url.host_str().unwrap_or("").to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        // B2 定时下载：仅未来时间生效。过去/无效时间视为立即下载。
        let scheduled_at = options.scheduled_at.filter(|&at| at > now);
        let scheduled = scheduled_at.is_some();
        let require_approval = options.require_approval;

        let view = TaskView {
            id: id.clone(),
            kind,
            url: url.to_string(),
            filename: save_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or(filename),
            save_path: save_path.to_string_lossy().to_string(),
            total_bytes: 0,
            downloaded_bytes: 0,
            speed_bps: 0,
            eta_seconds: None,
            error: None,
            created_at: now,
            finished_at: None,
            connections,
            resumable: false,
            segments: Vec::new(),
            speed_limit,
            referer: options.referer.clone().or(None),
            user_agent: options
                .user_agent
                .clone()
                .or_else(|| Some(engine_options.user_agent.clone())),
            proxy: options.proxy.clone().or(engine_options.proxy.clone()),
            format: options.format.clone(),
            mime: None,
            resume_etag: None,
            domain,
            expected_checksum: match options.expected_checksum.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(raw) => Some(crate::verify::parse_user_sha256(raw).map_err(EngineError::message)?),
                None => None,
            },
            // 下载审核闸门：入口强制 require_approval 时任务停在待审核、不自动下载；
            // 否则保持原语义（定时任务暂停等 tick，普通任务入队立即下载）。
            status: if require_approval || scheduled {
                TaskStatus::Paused
            } else {
                TaskStatus::Queued
            },
            scheduled_at,
            pending_approval: require_approval,
        };

        let entry = Arc::new(TaskEntry {
            id: id.clone(),
            kind,
            url: view.url.clone(),
            user_agent: view
                .user_agent
                .clone()
                .unwrap_or_else(|| engine_options.user_agent.clone()),
            proxy: view.proxy.clone(),
            view: AsyncMutex::new(view.clone()),
            options: options.clone(),
            cancel: AsyncMutex::new(None),
            downloaded: AtomicU64::new(0),
            segments: Mutex::new(Vec::new()),
            limiter: RateLimiter::new(speed_limit),
            wanted_pause: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            sample: Mutex::new(Sample::default()),
        });

        self.tasks.write().insert(id.clone(), entry);
        self.order.lock().push(id.clone());
        self.emit(EngineEvent::Task(view.clone()));
        self.save().await;
        // 待审核任务与定时任务都不在此处启动：前者等 approve，后者等 tick 到点。
        if !require_approval && !scheduled {
            self.spawn_runner(id.clone()).await;
        }
        Ok(view)
    }

    /// 全局是否可用 aria2c：用户显式配置了路径，或便携包 / exe 同级的 `tools/` 下存在
    /// aria2c 即可。只检查文件存在（与 `media::aria2_candidates` + `aria2::locate` 同口径），
    /// 不实际运行——真正能不能跑由 `media::run` 里的 `aria2::locate` 兜底。
    fn aria2_available(options: &EngineOptions) -> bool {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(p) = options.aria2_path.as_deref().filter(|s| !s.trim().is_empty()) {
            if let Some(parent) = Path::new(p).parent() {
                if !parent.as_os_str().is_empty() {
                    dirs.push(parent.to_path_buf());
                }
            }
            dirs.push(Path::new(p).to_path_buf());
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                dirs.push(parent.join("tools"));
                dirs.push(parent.to_path_buf());
            }
        }
        crate::aria2::locate(&dirs).is_some()
    }

    async fn acquire_slot(self: &Arc<Self>, token: &CancellationToken) -> Option<SlotGuard> {
        loop {
            if token.is_cancelled() {
                return None;
            }
            {
                let max = self.options.read().max_active.max(1);
                let mut active = self.active.lock();
                if *active < max {
                    *active += 1;
                    return Some(SlotGuard {
                        engine: self.clone(),
                    });
                }
            }
            tokio::select! {
                _ = self.notify.notified() => {}
                _ = token.cancelled() => return None,
            }
        }
    }

    async fn spawn_runner(self: &Arc<Self>, id: String) {
        let Some(entry) = self.get(&id) else { return };
        {
            let view = entry.view.lock().await;
            if view.status == TaskStatus::Completed {
                return;
            }
            // 下载审核闸门：所有启动路径（add/resume/retry/resume_all/定时触发）
            // 都经过这里。未批准的任务一律不启动——这是唯一且最终的拦截点。
            if view.pending_approval {
                return;
            }
        }

        // P1-6 修复：检查与置位必须在同一临界区。原来是「先读 cancel 判断有没有
        // 在跑，隔了几个 await，再写新 token」，并发 resume 会各自启动一个 runner，
        // 后写的 token 覆盖前一个；pause 只取消得到最后一个，旧 runner 继续下载。
        let token = CancellationToken::new();
        {
            let mut cancel = entry.cancel.lock().await;
            if cancel
                .as_ref()
                .map(|t| !t.is_cancelled())
                .unwrap_or(false)
            {
                return;
            }
            *cancel = Some(token.clone());
        }

        {
            let mut view = entry.view.lock().await;
            view.status = TaskStatus::Queued;
            view.error = None;
        }
        entry.wanted_pause.store(false, Ordering::SeqCst);
        entry.finished.store(false, Ordering::SeqCst);
        {
            // 0.3.8：恢复要连平滑速度一起清零。只清 `at` 会让 EMA 继承暂停前的高速，
            // 恢复瞬间显示一个虚高且缓慢衰减的速度，而不是从当前真实值重新起步。
            let mut s = entry.sample.lock();
            s.at = None;
            s.speed = 0;
        }
        self.emit_task(&entry).await;

        let engine = self.clone();
        tokio::spawn(async move {
            let entry_ref = entry.clone();
            if let Some(_guard) = engine.acquire_slot(&token).await {
                engine.run_task(entry, token.clone()).await;
            }
            // 退出前 cancel 自己的 token 并清理 cancel 槽位，避免失败后 retry/resume
            // 被误判为「仍在运行」而卡死。但必须「条件清空」：并发 resume 会新建 token
            // 覆盖槽位，旧 runner 若无条件清空，会把新 runner 的 token 抹掉，导致
            // pause 只取消到部分连接、漏掉仍在下载的连接（p1_6 回归）。
            token.cancel();
            let mut cancel = entry_ref.cancel.lock().await;
            if cancel.as_ref() == Some(&token) {
                *cancel = None;
            }
        });
    }

    async fn run_task(self: Arc<Self>, entry: Arc<TaskEntry>, token: CancellationToken) {
        {
            let mut view = entry.view.lock().await;
            if view.status != TaskStatus::Queued {
                return;
            }
            view.status = TaskStatus::Connecting;
        }
        self.emit_task(&entry).await;

        let result = match entry.kind {
            TaskKind::Http => http::run(&self, &entry, token.clone()).await,
            TaskKind::Media => media::run(&self, &entry, token.clone()).await,
        };

        if !self.has(&entry.id) {
            return;
        }

        let mut view = entry.view.lock().await;
        if token.is_cancelled() {
            if entry.wanted_pause.load(Ordering::SeqCst) {
                view.status = TaskStatus::Paused;
                view.eta_seconds = None;
                view.speed_bps = 0;
            }
        } else {
            match result {
                Ok(()) => {
                    view.status = TaskStatus::Completed;
                    view.finished_at = Some(chrono::Utc::now().timestamp_millis());
                    view.eta_seconds = None;
                    if view.total_bytes > 0 {
                        view.downloaded_bytes = view.total_bytes;
                        entry.downloaded.store(view.total_bytes, Ordering::Relaxed);
                    }
                    view.speed_bps = 0;
                    entry.finished.store(true, Ordering::SeqCst);
                }
                Err(EngineError::Paused) => {
                    view.status = TaskStatus::Paused;
                    view.speed_bps = 0;
                }
                Err(err) => {
                    view.status = TaskStatus::Failed;
                    view.error = Some(err.to_string());
                    view.speed_bps = 0;
                    view.eta_seconds = None;
                    // P0-1 修复：失败任务释放路径占位（part 若仍存在，taken() 依然能挡住）。
                    self.release_reserved(&view.save_path);
                    drop(view);
                    self.emit_log(&entry.id, format!("失败：{err}"));
                    self.emit_task(&entry).await;
                    self.save().await;
                    return;
                }
            }
        }
        view.downloaded_bytes = entry.downloaded.load(Ordering::Relaxed);
        view.segments = entry.segments.lock().clone();
        // P0-1 修复：完成的任务释放占位，让用户删掉文件后还能重新用回原名。
        // 注意暂停状态不释放——暂停的任务仍持有 part，需要继续占着这个路径。
        let completed = view.status == TaskStatus::Completed;
        let save_path = view.save_path.clone();
        drop(view);
        if completed {
            self.release_reserved(&save_path);
        }
        self.emit_task(&entry).await;
        self.save().await;
    }

    /// 释放 `add` 时为任务占用的目标路径。用同步锁，不跨 await。
    fn release_reserved(&self, save_path: &str) {
        self.reserved.lock().remove(&PathBuf::from(save_path));
    }

    pub async fn pause(&self, id: &str) {
        let Some(entry) = self.get(id) else { return };
        entry.wanted_pause.store(true, Ordering::SeqCst);
        if let Some(token) = entry.cancel.lock().await.clone() {
            token.cancel();
        }
        let mut view = entry.view.lock().await;
        if view.status.is_active() || view.status == TaskStatus::Queued {
            view.status = TaskStatus::Paused;
        }
        // B2：手动暂停视为取消定时，清掉计划时间。
        view.scheduled_at = None;
        view.speed_bps = 0;
        view.eta_seconds = None;
        drop(view);
        self.emit_task(&entry).await;
        self.save().await;
    }

    pub async fn resume(self: &Arc<Self>, id: &str) {
        let Some(entry) = self.get(id) else { return };
        {
            let mut view = entry.view.lock().await;
            if view.status.is_active() || view.status == TaskStatus::Completed {
                return;
            }
            // 待审核任务不能被「继续」绕过，也不能在此清掉定时标记。
            if view.pending_approval {
                self.emit_log(id, "该下载仍在等待审核，请先点「允许」".to_string());
                return;
            }
            // B2：手动恢复视为立即开始，取消原定的定时。
            view.scheduled_at = None;
        }
        self.spawn_runner(id.to_string()).await;
    }

    /// 审核通过：清除待审核标记并启动下载。
    /// 定时任务批准后若计划时间仍在未来，则保持暂停交给 tick 到点触发，
    /// 否则立即开始。这是唯一能把 pending_approval 从 true 翻成 false 的入口。
    pub async fn approve(self: &Arc<Self>, id: &str) {
        let Some(entry) = self.get(id) else { return };
        let due_now = {
            let mut view = entry.view.lock().await;
            if !view.pending_approval {
                return;
            }
            view.pending_approval = false;
            // 定时任务：计划时间已过则立即开始，未来则保留等待 tick。
            let due = view
                .scheduled_at
                .map(|at| at <= chrono::Utc::now().timestamp_millis())
                .unwrap_or(true);
            if due {
                view.scheduled_at = None;
            }
            view.status = TaskStatus::Paused;
            due
        };
        self.emit_task(&entry).await;
        if due_now {
            self.spawn_runner(id.to_string()).await;
        }
        self.save().await;
    }

    /// 一次批准当前全部待审核任务。
    pub async fn approve_all(self: &Arc<Self>) {
        let ids: Vec<String> = {
            let entries = self.tasks.read().values().cloned().collect::<Vec<_>>();
            let mut ids = Vec::new();
            for entry in entries {
                if entry.view.lock().await.pending_approval {
                    ids.push(entry.id.clone());
                }
            }
            ids
        };
        for id in ids {
            self.approve(&id).await;
        }
    }

    pub async fn retry(self: &Arc<Self>, id: &str) {
        let Some(entry) = self.get(id) else { return };
        {
            let mut view = entry.view.lock().await;
            view.error = None;
            view.status = TaskStatus::Paused;
            view.finished_at = None;
            view.scheduled_at = None;
        }
        // If the previous attempt never got a byte, segments may be stale.
        if entry.downloaded.load(Ordering::Relaxed) == 0 {
            entry.segments.lock().clear();
        }
        self.spawn_runner(id.to_string()).await;
    }

    /// 过期链接续期：为未完成任务替换新的下载链接（例如签名过期 403/410），
    /// 保留已下载的 `.fluxdl-part` 与分段进度，清空旧 `resume_etag` 让引擎通过
    /// 重叠字节校验安全续传，避免串文件且无需从零重下。
    pub async fn update_task_url(
        self: &Arc<Self>,
        id: &str,
        new_url: String,
        auto_resume: bool,
    ) -> Result<TaskView, EngineError> {
        let trimmed = new_url.trim();
        let parsed = url::Url::parse(trimmed)
            .map_err(|_| EngineError::message("新链接格式无效，请输入完整的 http/https 链接"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(EngineError::message("仅支持 http:// 或 https:// 链接"));
        }
        let entry = self
            .get(id)
            .ok_or_else(|| EngineError::message("未找到对应任务"))?;

        // 若任务仍在运行，先取消当前 runner，防止旧连接继续写盘。
        if let Some(token) = entry.cancel.lock().await.take() {
            token.cancel();
        }

        let (snapshot, can_resume) = {
            let mut view = entry.view.lock().await;
            if view.status == TaskStatus::Completed {
                return Err(EngineError::message("任务已完成，无需更换链接"));
            }
            view.url = trimmed.to_string();
            view.domain = parsed.host_str().unwrap_or("").to_string();
            view.error = None;
            // 清空旧 ETag，交由 http.rs 的重叠字节校验确认新链接指向同一份文件。
            view.resume_etag = None;
            view.status = TaskStatus::Paused;
            view.speed_bps = 0;
            view.eta_seconds = None;
            view.scheduled_at = None;
            let can_resume = auto_resume && !view.pending_approval;
            (view.clone(), can_resume)
        };

        self.emit_log(id, format!("已更新下载链接（{}），保留已有进度准备续传", snapshot.domain));
        self.emit_task(&entry).await;
        self.save().await;

        if can_resume {
            self.spawn_runner(id.to_string()).await;
        }
        Ok(snapshot)
    }

    /// 核对或登记任务 SHA-256 校验和：
    /// - 已完成任务：流式计算磁盘文件 SHA-256 并即时返回比对结果；
    /// - 未完成任务：保存预期 SHA-256，下载完成落盘前自动校验。
    pub async fn verify_task_checksum(
        &self,
        id: &str,
        expected: String,
    ) -> Result<crate::verify::ChecksumVerification, EngineError> {
        let normalized = crate::verify::parse_user_sha256(&expected).map_err(EngineError::message)?;
        let entry = self
            .get(id)
            .ok_or_else(|| EngineError::message("未找到对应任务"))?;

        let (status, save_path) = {
            let mut view = entry.view.lock().await;
            view.expected_checksum = Some(normalized.clone());
            (view.status, PathBuf::from(&view.save_path))
        };
        self.emit_task(&entry).await;
        self.save().await;

        if status != TaskStatus::Completed {
            return Ok(crate::verify::ChecksumVerification {
                matched: false,
                pending: true,
                expected: normalized,
                actual: String::new(),
            });
        }

        if !save_path.exists() {
            return Err(EngineError::message("目标文件不存在或已被移动，无法计算校验和"));
        }

        let actual = tokio::task::spawn_blocking(move || crate::verify::hash_file_sha256(&save_path))
            .await
            .map_err(|e| EngineError::message(format!("校验任务执行失败：{e}")))?
            .map_err(|e| EngineError::message(format!("读取文件计算 SHA-256 失败：{e}")))?;

        let matched = actual.eq_ignore_ascii_case(&normalized);
        self.emit_log(
            id,
            if matched {
                "SHA-256 校验通过".to_string()
            } else {
                format!("SHA-256 校验不匹配：实际 {actual}")
            },
        );
        Ok(crate::verify::ChecksumVerification {
            matched,
            pending: false,
            expected: normalized,
            actual,
        })
    }

    pub async fn remove(&self, id: &str, delete_file: bool) {
        let Some(entry) = self.tasks.write().remove(id) else {
            return;
        };
        self.order.lock().retain(|x| x != id);
        if let Some(token) = entry.cancel.lock().await.clone() {
            token.cancel();
        }
        if delete_file {
            let path = entry.view.lock().await.save_path.clone();
            self.reserved.lock().remove(&PathBuf::from(&path));
            tokio::spawn(async move {
                let p = PathBuf::from(&path);
                // P1-4 修复：未完成任务的真实数据在 .fluxdl-part 里，必须一并清理。
                let part = PathBuf::from(format!("{path}.fluxdl-part"));
                if p.exists() {
                    let _ = tokio::fs::remove_file(&p).await;
                }
                if part.exists() {
                    let _ = tokio::fs::remove_file(&part).await;
                }
            });
        } else {
            let path = entry.view.lock().await.save_path.clone();
            self.reserved.lock().remove(&PathBuf::from(&path));
        }
        self.emit(EngineEvent::Removed(id.to_string()));
        self.save().await;
    }

    pub async fn pause_all(&self) {
        let entries = { self.tasks.read().values().cloned().collect::<Vec<_>>() };
        for entry in entries {
            self.pause(&entry.id).await;
        }
    }

    pub async fn resume_all(self: &Arc<Self>) {
        let entries = { self.tasks.read().values().cloned().collect::<Vec<_>>() };
        for entry in entries {
            let status = entry.view.lock().await.status;
            match status {
                TaskStatus::Paused => {
                    {
                        let mut view = entry.view.lock().await;
                        // 待审核任务不能被「全部继续」批量放行，也不清定时标记。
                        if view.pending_approval {
                            continue;
                        }
                        // B2：全部继续也取消定时，避免启动后 UI 仍显示计划时间。
                        view.scheduled_at = None;
                    }
                    self.spawn_runner(entry.id.clone()).await;
                }
                TaskStatus::Failed => self.retry(&entry.id).await,
                _ => {}
            }
        }
    }

    pub async fn set_speed_limit(&self, id: &str, limit: Option<u64>) {
        let Some(entry) = self.get(id) else { return };
        let limit = limit.filter(|v| *v > 0);
        entry.limiter.set_limit(limit);
        let mut view = entry.view.lock().await;
        view.speed_limit = limit;
        drop(view);
        self.emit_task(&entry).await;
        self.save().await;
    }

    pub async fn set_global_speed_limit(&self, limit: Option<u64>) {
        {
            let mut opts = self.options.write();
            opts.global_speed_limit = limit.filter(|v| *v > 0);
        }
        self.global_limiter.set_limit(limit);
        self.save().await;
    }

    pub async fn save(&self) {
        // 必须在收集快照之前就持锁：两个 save 若交错写同一个 tmp，
        // 后一个 rename 会找不到 tmp，而目标已被前一个删掉——任务列表直接丢失。
        let _guard = self.save_lock.lock().await;
        let order = self.order.lock().clone();
        let entries: Vec<Arc<TaskEntry>> = {
            let tasks = self.tasks.read();
            order.iter().filter_map(|id| tasks.get(id).cloned()).collect()
        };
        let mut tasks = Vec::with_capacity(entries.len());
        for entry in entries {
            let mut view = entry.view.lock().await.clone();
            view.segments = entry.segments.lock().clone();
            view.downloaded_bytes = entry.downloaded.load(Ordering::Relaxed);
            tasks.push(PersistedTask {
                view,
                options: entry.options.clone(),
            });
        }
        let store = StoreFile {
            options: Some(self.options.read().clone()),
            tasks,
        };
        if let Err(err) = store::save(&self.store_path, &store).await {
            self.emit_log("", format!("任务列表保存失败：{err}"));
        }
    }

    /// B2 定时下载：扫描到点的定时任务，清空标记并启动。
    /// 独立方法（非 tick）以便拿到 &Arc<Self> 调用 spawn_runner，
    /// 同时保持 tick(&self) 签名不变（速度契约脚本按签名文本定位 tick 函数体）。
    async fn trigger_due_schedules(self: &Arc<Self>) {
        let wall_now = chrono::Utc::now().timestamp_millis();
        let all: Vec<Arc<TaskEntry>> = self.tasks.read().values().cloned().collect();
        for entry in all {
            let is_due = {
                let view = entry.view.lock().await;
                view.status == TaskStatus::Paused
                    && !view.pending_approval
                    && view.scheduled_at.map(|at| at <= wall_now).unwrap_or(false)
            };
            if !is_due {
                continue;
            }
            {
                let mut view = entry.view.lock().await;
                // 再次确认仍未被用户手动处理（幂等，防并发 tick）。
                if view.status != TaskStatus::Paused || view.scheduled_at.is_none() {
                    continue;
                }
                view.scheduled_at = None;
            }
            self.emit_log(&entry.id, "定时时间已到，自动开始下载");
            self.spawn_runner(entry.id.clone()).await;
        }
    }

    async fn tick(&self) {
        let entries: Vec<Arc<TaskEntry>> = self.tasks.read().values().cloned().collect();
        let now = Instant::now();
        let mut any_active = false;

        for entry in entries {
            let bytes = entry.downloaded.load(Ordering::Relaxed);
            let is_media = entry.kind == TaskKind::Media;

            // 0.3.8：速度按任务类型分工，消除「两个写入者交替覆盖」。
            // · Media：`view.speed_bps` / `eta_seconds` 由 media::run 的进度行独占
            //   （yt-dlp / aria2 自己的速度经 EMA 平滑后写入）。tick 若再用
            //   `entry.downloaded` 差分覆盖，两个来源以 400ms / 500ms 不同节奏写
            //   同一个字段，正是速度数字与曲线来回跳的根因。
            // · HTTP：没有子进程进度行，速度只能由本采样器提供，且瞬时差分要先过
            //   EMA 削掉 TCP 抖动 / 分段写入节奏造成的尖峰与谷底。
            let speed = if is_media {
                0
            } else {
                let mut sample = entry.sample.lock();
                let instant = match sample.at {
                    Some(prev) => {
                        let dt = now.duration_since(prev).as_secs_f64();
                        if dt > 0.0 {
                            ((bytes.saturating_sub(sample.bytes)) as f64 / dt) as u64
                        } else {
                            sample.speed
                        }
                    }
                    None => 0,
                };
                sample.bytes = bytes;
                sample.at = Some(now);
                // 首帧 prev=0 时 EMA 直接采用 instant，起步不会被拖慢；之后逐帧削峰。
                sample.speed = util::smooth_speed(sample.speed, instant);
                sample.speed
            };

            let mut view = entry.view.lock().await;
            view.downloaded_bytes = bytes;
            view.segments = entry.segments.lock().clone();
            if view.status.is_active() {
                any_active = true;
                if !is_media {
                    view.speed_bps = speed;
                    // 0.3.8：与 Media 共用同一纯函数，剩余时间也按平滑速度重算，
                    // 总量未知 / 已完成 / 速度未知时返回 None，不显示虚假的 0。
                    view.eta_seconds = util::eta_from_speed(view.total_bytes, bytes, speed, None);
                }
            } else {
                view.speed_bps = 0;
                view.eta_seconds = None;
            }
            let snapshot = view.clone();
            drop(view);
            self.emit(EngineEvent::Task(snapshot));
        }

        if any_active {
            let n = self.ticks.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 10 == 0 {
                self.save().await;
            }
        }
    }
}
