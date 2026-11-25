pub mod aria2;
mod douyin;
mod http;
mod limit;
mod manager;
mod media;
pub mod planner;
mod store;
mod types;
pub mod update;
mod util;
pub mod ytdlp;

pub use limit::RateLimiter;
pub use manager::{Engine, EngineError};
// 0.3.5：CDN 容器直链判定作为跨层权威规则导出，供 Tauri 建任务时复用，
// 避免与前端 / 扩展的等价判定分裂。
pub use media::{is_direct_media_file, is_hls_manifest, media_page_blocker};
pub use types::*;
pub use update::{Recovery, SwapState, ToolState, UpdateManifest};

pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
