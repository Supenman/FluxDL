use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Queued,
    Connecting,
    Downloading,
    #[default]
    Paused,
    Completed,
    Failed,
}

impl TaskStatus {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Connecting | Self::Downloading)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    #[default]
    Http,
    Media,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SegmentView {
    pub index: usize,
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
    pub done: bool,
}

impl SegmentView {
    pub fn length(&self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
}

/// 旧版 `tasks.json` 可能缺少后加的字段（domain / referer / format …）。
/// 结构级 `default` 让缺字段回落到零值，配合 `store::load` 的逐条解析，
/// 一条坏数据不再把整份任务列表带成空表。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskView {
    pub id: String,
    pub kind: TaskKind,
    pub url: String,
    pub filename: String,
    pub save_path: String,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub speed_bps: u64,
    pub eta_seconds: Option<u64>,
    pub status: TaskStatus,
    pub error: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub connections: u8,
    pub resumable: bool,
    pub segments: Vec<SegmentView>,
    pub speed_limit: Option<u64>,
    pub referer: Option<String>,
    pub user_agent: Option<String>,
    pub proxy: Option<String>,
    pub format: Option<String>,
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_etag: Option<String>,
    pub domain: String,
    /// B2 定时下载：计划开始的 UTC 毫秒时间戳。有值且任务处于 Paused 时表示
    /// 等待定时触发；触发完成或用户手动 pause/resume 后清空。
    pub scheduled_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewTaskOptions {
    pub save_dir: Option<String>,
    pub filename: Option<String>,
    /// 服务器 `Content-Disposition` 里的文件名优先于调用方给的建议名（浏览器捕获用）。
    pub prefer_header_filename: bool,
    pub connections: Option<u8>,
    pub speed_limit: Option<u64>,
    pub referer: Option<String>,
    pub user_agent: Option<String>,
    pub proxy: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub format: Option<String>,
    /// B2 定时下载：期望的开始时间（UTC 毫秒时间戳）。仅当时间在未来时生效；
    /// 到点前任务保持暂停，到点由引擎 tick 自动启动。
    pub scheduled_at: Option<i64>,
    /// 本次任务是否允许用 aria2c 作为 yt-dlp 的外部下载器（多连接）。
    ///
    /// 单独放在任务级而不是只放全局，是因为限速是**按任务**设置的：任务一旦
    /// 限速，就必须关掉 aria2c，否则 aria2c 会绕开 `RateLimiter` 把限速架空。
    /// 默认 true；限速任务在创建时由引擎置为 false。
    pub aria2: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineOptions {
    pub save_dir: String,
    /// Organize new downloads into folders by file type under the selected save directory.
    pub organize_by_category: bool,
    pub max_active: usize,
    pub connections: u8,
    pub global_speed_limit: Option<u64>,
    pub proxy: Option<String>,
    pub user_agent: String,
    pub yt_dlp_path: String,
    pub ffmpeg_path: Option<String>,
    /// aria2c 可执行文件的完整路径。留空时按「yt-dlp / ffmpeg 所在目录、随包
    /// tools/ 目录、exe 同级目录」的顺序自动探测；探测不到就退回 yt-dlp 原生
    /// 下载器（功能不中断，只是失去多连接提速）。
    #[serde(default)]
    pub aria2_path: Option<String>,
    /// 是否在后台自动更新随包内置的 yt-dlp（视频站点提取器频繁改版，旧版会解析失败）。
    /// 默认开启；仅对随包内置的 yt-dlp 生效，PATH 里的系统 yt-dlp 不接管。
    pub auto_update_yt_dlp: bool,
    pub clipboard_watch: bool,
    pub close_to_tray: bool,
    pub open_folder_after: bool,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self {
            save_dir: dirs::download_dir()
                .or_else(dirs::home_dir)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ".".into()),
            organize_by_category: false,
            max_active: 3,
            connections: 0, // 自动档：由 http.rs 按文件体积收敛；1-32 为用户显式值
            global_speed_limit: None,
            proxy: None,
            user_agent: "FluxDL/0.1 (Windows)".into(),
            yt_dlp_path: "yt-dlp".into(),
            ffmpeg_path: None,
            aria2_path: None,
            auto_update_yt_dlp: true,
            clipboard_watch: true,
            close_to_tray: true,
            open_folder_after: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "payload")]
pub enum EngineEvent {
    Task(TaskView),
    Removed(String),
    Log(LogLine),
    ClipboardUrl(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub task_id: String,
    pub message: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub version: String,
    pub os: String,
    pub yt_dlp_path: String,
    pub yt_dlp_available: bool,
    pub ffmpeg_available: bool,
}
