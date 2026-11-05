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
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, raw).await?;
    if path.exists() {
        tokio::fs::remove_file(path).await.ok();
    }
    tokio::fs::rename(&tmp, path).await
}
