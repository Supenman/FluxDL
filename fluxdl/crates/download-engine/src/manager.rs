use crate::http;
use crate::limit::RateLimiter;
use crate::media;
use crate::store::{self, PersistedTask, StoreFile};
use crate::types::*;
use crate::util;
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::PathBuf;
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
    events: mpsc::UnboundedSender<EngineEvent>,
    global_limiter: Arc<RateLimiter>,
    active: Mutex<usize>,
    notify: Notify,
    ticks: AtomicU64,
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
        let stored = store::load(&store_path);
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
            events,
            global_limiter,
            active: Mutex::new(0),
            notify: Notify::new(),
            ticks: AtomicU64::new(0),
        });

        // Hydrate segment lists + rate limiters from the persisted views.
        {
            let map = engine.tasks.read();
            for entry in map.values() {
                let view = entry.view.try_lock();
                if let Ok(view) = view {
                    *entry.segments.lock() = view.segments.clone();
                    entry.limiter.set_limit(view.speed_limit);
                    entry
                        .downloaded
                        .store(view.downloaded_bytes, Ordering::Relaxed);
                }
            }
        }

        let weak = Arc::downgrade(&engine);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(500));
            loop {
                ticker.tick().await;
                let Some(engine) = weak.upgrade() else { break };
                engine.tick().await;
            }
        });

        engine
    }

    pub fn options(&self) -> EngineOptions {
        self.options.read().clone()
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
        let url = url::Url::parse(raw_url.trim())
            .map_err(|_| EngineError::message("链接格式不正确"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(EngineError::message("仅支持 http / https 链接"));
        }

        let engine_options = self.options.read().clone();
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
        if kind == TaskKind::Http {
            util::ensure_dir(&dir)?;
        }
        let save_path = util::unique_path(&dir, &filename);
        let connections = options
            .connections
            .unwrap_or(engine_options.connections)
            .clamp(1, 32);
        let speed_limit = options.speed_limit.filter(|v| *v > 0);
        let domain = url.host_str().unwrap_or("").to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();

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
            status: TaskStatus::Queued,
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
            domain,
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
        self.spawn_runner(id.clone()).await;
        Ok(view)
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
        let already_running = entry
            .cancel
            .lock()
            .await
            .as_ref()
            .map(|token| !token.is_cancelled())
            .unwrap_or(false);
        if already_running {
            return;
        }
        {
            let mut view = entry.view.lock().await;
            if view.status == TaskStatus::Completed {
                return;
            }
            view.status = TaskStatus::Queued;
            view.error = None;
        }
        entry.wanted_pause.store(false, Ordering::SeqCst);
        entry.finished.store(false, Ordering::SeqCst);
        entry.sample.lock().at = None;
        let token = CancellationToken::new();
        *entry.cancel.lock().await = Some(token.clone());
        self.emit_task(&entry).await;

        let engine = self.clone();
        tokio::spawn(async move {
            let _guard = match engine.acquire_slot(&token).await {
                Some(g) => g,
                None => return, // paused or removed while queued
            };
            engine.run_task(entry, token).await;
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
        drop(view);
        self.emit_task(&entry).await;
        self.save().await;
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
        view.speed_bps = 0;
        view.eta_seconds = None;
        drop(view);
        self.emit_task(&entry).await;
        self.save().await;
    }

    pub async fn resume(self: &Arc<Self>, id: &str) {
        let Some(entry) = self.get(id) else { return };
        {
            let view = entry.view.lock().await;
            if view.status.is_active() || view.status == TaskStatus::Completed {
                return;
            }
        }
        self.spawn_runner(id.to_string()).await;
    }

    pub async fn retry(self: &Arc<Self>, id: &str) {
        let Some(entry) = self.get(id) else { return };
        {
            let mut view = entry.view.lock().await;
            view.error = None;
            view.status = TaskStatus::Paused;
            view.finished_at = None;
        }
        // If the previous attempt never got a byte, segments may be stale.
        if entry.downloaded.load(Ordering::Relaxed) == 0 {
            entry.segments.lock().clear();
        }
        self.spawn_runner(id.to_string()).await;
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
            tokio::spawn(async move {
                let p = PathBuf::from(path);
                if p.exists() {
                    let _ = tokio::fs::remove_file(p).await;
                }
            });
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
            if status == TaskStatus::Paused {
                self.spawn_runner(entry.id.clone()).await;
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
        let entries: Vec<Arc<TaskEntry>> = self.tasks.read().values().cloned().collect();
        let mut tasks = Vec::with_capacity(entries.len());
        let order = self.order.lock().clone();
        for id in order {
            if let Some(entry) = entries.iter().find(|e| e.id == id) {
                let mut view = entry.view.lock().await.clone();
                view.segments = entry.segments.lock().clone();
                view.downloaded_bytes = entry.downloaded.load(Ordering::Relaxed);
                tasks.push(PersistedTask {
                    view,
                    options: entry.options.clone(),
                });
            }
        }
        let store = StoreFile {
            options: Some(self.options.read().clone()),
            tasks,
        };
        if let Err(err) = store::save(&self.store_path, &store).await {
            self.emit_log("", format!("任务列表保存失败：{err}"));
        }
    }

    async fn tick(&self) {
        let entries: Vec<Arc<TaskEntry>> = self.tasks.read().values().cloned().collect();
        let now = Instant::now();
        let mut any_active = false;

        for entry in entries {
            let bytes = entry.downloaded.load(Ordering::Relaxed);
            let speed = {
                let mut sample = entry.sample.lock();
                let speed = match sample.at {
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
                sample.speed = speed;
                speed
            };

            let mut view = entry.view.lock().await;
            view.downloaded_bytes = bytes;
            view.segments = entry.segments.lock().clone();
            if view.status.is_active() {
                any_active = true;
                view.speed_bps = speed;
                view.eta_seconds = if view.total_bytes > 0 && speed > 0 {
                    Some(
                        view.total_bytes
                            .saturating_sub(bytes)
                            .saturating_div(speed.max(1)),
                    )
                } else {
                    None
                };
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
