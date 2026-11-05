use crate::types::{EngineOptions, NewTaskOptions, TaskStatus, TaskView};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

pub fn load(path: &Path) -> StoreFile {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return StoreFile::default();
    };
    let mut store: StoreFile = serde_json::from_str(&raw).unwrap_or_default();
    // Anything that was mid-flight when the app exited is shown as paused,
    // so we never silently burn bandwidth on startup.
    for task in &mut store.tasks {
        if task.view.status.is_active() {
            task.view.status = TaskStatus::Paused;
            task.view.speed_bps = 0;
            task.view.eta_seconds = None;
        }
    }
    store
}

pub async fn save(path: &Path, store: &StoreFile) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let raw = serde_json::to_vec_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

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
