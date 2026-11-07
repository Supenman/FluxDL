use crate::types::{EngineOptions, NewTaskOptions, TaskStatus, TaskView};
use serde::{Deserialize, Serialize};
use std::path::Path;

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

pub fn load(path: &Path) -> StoreFile {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return StoreFile::default();
    };
    // 逐条解析，而不是整表 from_str：旧版本升级后只要有一条任务缺字段或格式损坏，
    // 整表反序列化就会失败，把所有已完成任务和续传 part 一起丢掉。
    // 这里按字段拆开读，坏条目单独跳过，其余任务照常恢复。
    let mut store = StoreFile::default();
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return store;
    };
    if let Some(options) = root.get("options") {
        store.options = serde_json::from_value(options.clone()).ok();
    }
    if let Some(tasks) = root.get("tasks").and_then(|v| v.as_array()) {
        for item in tasks {
            if let Ok(task) = serde_json::from_value::<PersistedTask>(item.clone()) {
                store.tasks.push(task);
            }
        }
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
