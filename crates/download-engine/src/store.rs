use crate::types::{EngineOptions, NewTaskOptions, TaskStatus, TaskView};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedTask {
    pub view: TaskView,
    pub options: NewTaskOptions,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoreFile {
    pub options: Option<EngineOptions>,
    pub tasks: Vec<PersistedTask>,
}

pub fn load(path: &Path) -> (StoreFile, bool) {
    if let Some(store) = read_snapshot(path) {
        return (store, false);
    }
    match read_snapshot(&backup_path(path)) {
        Some(store) => (store, true),
        None => (StoreFile::default(), false),
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".bak");
    name.into()
}

fn read_snapshot(path: &Path) -> Option<StoreFile> {
    let raw = std::fs::read(path).ok()?;
    let root: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let tasks = root.get("tasks")?.as_array()?;
    // 逐条解析，而不是整表 from_str：旧版本升级后只要有一条任务缺字段或格式损坏，
    // 整表反序列化就会失败，把所有已完成任务和续传 part 一起丢掉。
    // 这里按字段拆开读，坏条目单独跳过，其余任务照常恢复。
    let mut store = StoreFile::default();
    if let Some(options) = root.get("options") {
        store.options = serde_json::from_value(options.clone()).ok();
    }
    for item in tasks {
        if let Ok(task) = serde_json::from_value::<PersistedTask>(item.clone()) {
            store.tasks.push(task);
        }
    }
    if !tasks.is_empty() && store.tasks.is_empty() {
        return None;
    }
    // Anything that was mid-flight when the app exited is shown as paused,
    // so we never silently burn bandwidth on startup.
    for task in &mut store.tasks {
        if task.view.status.is_active() {
            task.view.status = TaskStatus::Paused;
            task.view.speed_bps = 0;
            task.view.eta_seconds = None;
        }
    }
    Some(store)
}

pub async fn save(path: &Path, store: &StoreFile) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let raw = serde_json::to_vec_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Commit the main snapshot first so a failed write leaves the previous backup intact.
    write_snapshot(path, &raw).await?;
    write_snapshot(&backup_path(path), &raw).await
}

async fn write_snapshot(path: &Path, raw: &[u8]) -> std::io::Result<()> {
    // tmp 带 pid，避免多个进程实例互相踩同一个临时文件。
    let mut name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "tasks.json".into());
    name.push_str(&format!(".{}.tmp", std::process::id()));
    let tmp = path.with_file_name(name);
    tokio::fs::write(&tmp, raw).await?;

    // 直接 rename 覆盖，不要再先删目标：删掉后到改名之间若失败（或崩溃），
    // 任务列表就凭空消失了。Rust 的 rename 在 Windows 上带 MOVEFILE_REPLACE_EXISTING，
    // 能覆盖已存在的文件。
    match tokio::fs::rename(&tmp, path).await {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(err)
        }
    }
}
