use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Queued,
    Connecting,
    Downloading,
    Paused,
    Completed,
    Failed,
}

impl TaskStatus {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Connecting | Self::Downloading)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    pub domain: String,
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
    /// yt-dlp 用的 Netscape cookies.txt 临时文件路径（仅媒体任务）。
    /// 只存路径不存内容：cookie 是凭证，绝不能写进 tasks.json。
    pub cookies_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineOptions {
    pub save_dir: String,
    pub max_active: usize,
    pub connections: u8,
    pub global_speed_limit: Option<u64>,
    pub proxy: Option<String>,
    pub user_agent: String,
    pub yt_dlp_path: String,
    pub ffmpeg_path: Option<String>,
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
            max_active: 3,
            connections: 8,
            global_speed_limit: None,
            proxy: None,
            user_agent: "FluxDL/0.1 (Windows)".into(),
            yt_dlp_path: "yt-dlp".into(),
            ffmpeg_path: None,
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
