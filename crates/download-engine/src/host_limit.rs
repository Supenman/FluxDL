//! 阶段一 #5：每主机连接数学习（HostLimits）—— 纯逻辑层。
//!
//! 目标：记住每台服务器能承受的连接数，避免高并发被服务器限流/封禁。
//! 算法采用 AIMD（加性增、乘性减）：
//! - 乘性减：遇到 429/503/连接重置/超时 → 该主机上限减半（最低 1），快速退让；
//! - 加性增：连续成功累积到阈值 → 上限 +1（缓慢试探恢复）。
//!
//! 初始上限 = `DEFAULT_CEILING`（引擎硬上限），因此**没有失败记录时行为与现状一致**，
//! 只有真正观测到服务器压力才会收敛连接数。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use url::Url;

/// 单台主机的学习状态。只存整数，天然可序列化、可持久化。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostState {
    /// 当前允许的最大连接数。
    pub ceiling: usize,
    /// 连续成功计数（达到 ADD_THRESHOLD 后 +1 并归零）。
    pub success_streak: u32,
}

impl Default for HostState {
    fn default() -> Self {
        Self {
            ceiling: DEFAULT_CEILING,
            success_streak: 0,
        }
    }
}

/// 引擎连接数硬上限（与 types/http 的 1-32 显式范围一致）。
pub const DEFAULT_CEILING: usize = 32;
/// 连续成功多少次后加性增 1。
pub const ADD_THRESHOLD: u32 = 12;
/// 乘性减的分母（减半）。
pub const MULTIPLICATIVE_DECREASE: usize = 2;

/// 触发降级的失败类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// HTTP 429 Too Many Requests。
    TooManyRequests,
    /// HTTP 5xx 服务端过载。
    ServerError,
    /// 连接重置 / 超时 / 传输中断。
    Connection,
}

/// 每主机连接数学习表。所有方法都是同步纯数据操作，便于单测与跨线程共享。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HostLimits {
    hosts: BTreeMap<String, HostState>,
}

impl HostLimits {
    pub fn new() -> Self {
        Self::default()
    }

    /// 从 URL 提取 host（含端口）。解析失败时退回原始字符串，避免"学了个空 host"。
    pub fn host_key(url: &str) -> String {
        match Url::parse(url) {
            Ok(parsed) => parsed
                .host_str()
                .map(|h| {
                    match parsed.port() {
                        Some(port) => format!("{h}:{port}"),
                        None => h.to_string(),
                    }
                    .to_ascii_lowercase()
                })
                .unwrap_or_else(|| url.to_ascii_lowercase()),
            Err(_) => url.to_ascii_lowercase(),
        }
    }

    /// 建议连接数：`min(requested, ceiling)`。没有记录时 ceiling=32，不改变现有行为。
    pub fn suggest(&self, url: &str, requested: usize) -> usize {
        let key = Self::host_key(url);
        let ceiling = self
            .hosts
            .get(&key)
            .map(|s| s.ceiling)
            .unwrap_or(DEFAULT_CEILING);
        requested.min(ceiling).max(1)
    }

    /// 报告一次失败：乘性减上限，清零成功连击。
    pub fn on_failure(&mut self, url: &str, _kind: FailureKind) -> usize {
        let key = Self::host_key(url);
        let state = self.hosts.entry(key).or_default();
        state.ceiling = (state.ceiling / MULTIPLICATIVE_DECREASE).max(1);
        state.success_streak = 0;
        state.ceiling
    }

    /// 报告一次成功：累积连击，到阈值加性增 1（不越过硬上限）。
    pub fn on_success(&mut self, url: &str) -> usize {
        let key = Self::host_key(url);
        let state = self.hosts.entry(key).or_default();
        state.success_streak = state.success_streak.saturating_add(1);
        if state.success_streak >= ADD_THRESHOLD {
            state.success_streak = 0;
            state.ceiling = (state.ceiling + 1).min(DEFAULT_CEILING);
        }
        state.ceiling
    }

    /// 查询某主机当前上限（无记录 = 硬上限）。
    pub fn ceiling(&self, url: &str) -> usize {
        let key = Self::host_key(url);
        self.hosts
            .get(&key)
            .map(|s| s.ceiling)
            .unwrap_or(DEFAULT_CEILING)
    }

    /// 已学习的主机数量（日志/诊断用）。
    pub fn len(&self) -> usize {
        self.hosts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.hosts.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_strips_path_and_normalizes_case() {
        assert_eq!(
            HostLimits::host_key("https://Example.COM:443/a/b.bin?x=1"),
            "example.com"
        );
        assert_eq!(
            HostLimits::host_key("http://dl.example.com:8080/f"),
            "dl.example.com:8080"
        );
        assert_eq!(HostLimits::host_key("not a url"), "not a url");
    }

    #[test]
    fn no_record_means_full_ceiling() {
        let limits = HostLimits::new();
        assert_eq!(limits.suggest("https://a.com/x", 16), 16);
        assert_eq!(limits.ceiling("https://a.com/x"), DEFAULT_CEILING);
        assert!(limits.is_empty());
    }

    #[test]
    fn failure_multiplicatively_decreases() {
        let mut limits = HostLimits::new();
        assert_eq!(limits.on_failure("https://a.com/x", FailureKind::TooManyRequests), 16);
        assert_eq!(limits.suggest("https://a.com/x", 32), 16);
        assert_eq!(limits.on_failure("https://a.com/x", FailureKind::ServerError), 8);
        assert_eq!(limits.on_failure("https://a.com/x", FailureKind::Connection), 4);
    }

    #[test]
    fn decrease_has_floor_of_one() {
        let mut limits = HostLimits::new();
        for _ in 0..10 {
            limits.on_failure("https://a.com/x", FailureKind::TooManyRequests);
        }
        assert_eq!(limits.ceiling("https://a.com/x"), 1);
    }

    #[test]
    fn success_additively_increases_after_threshold() {
        let mut limits = HostLimits::new();
        limits.on_failure("https://a.com/x", FailureKind::Connection); // 32 -> 16
        // 未达阈值不加
        for _ in 0..(ADD_THRESHOLD - 1) {
            limits.on_success("https://a.com/x");
        }
        assert_eq!(limits.ceiling("https://a.com/x"), 16);
        // 达到阈值 +1
        limits.on_success("https://a.com/x");
        assert_eq!(limits.ceiling("https://a.com/x"), 17);
    }

    #[test]
    fn success_never_exceeds_hard_ceiling() {
        let mut limits = HostLimits::new();
        for _ in 0..(ADD_THRESHOLD * 10) {
            limits.on_success("https://a.com/x");
        }
        assert_eq!(limits.ceiling("https://a.com/x"), DEFAULT_CEILING);
    }

    #[test]
    fn hosts_are_isolated() {
        let mut limits = HostLimits::new();
        limits.on_failure("https://a.com/x", FailureKind::ServerError);
        assert_eq!(limits.ceiling("https://a.com/x"), 16);
        assert_eq!(limits.ceiling("https://b.com/y"), DEFAULT_CEILING);
        assert_eq!(limits.len(), 1);
    }

    #[test]
    fn failure_resets_success_streak() {
        let mut limits = HostLimits::new();
        for _ in 0..(ADD_THRESHOLD - 1) {
            limits.on_success("https://a.com/x");
        }
        limits.on_failure("https://a.com/x", FailureKind::Connection);
        for _ in 0..(ADD_THRESHOLD - 1) {
            limits.on_success("https://a.com/x");
        }
        // 中途失败清零了连击，所以仍停在降级后的 ceiling
        assert_eq!(limits.ceiling("https://a.com/x"), 16);
    }

    #[test]
    fn serde_roundtrip() {
        let mut limits = HostLimits::new();
        limits.on_failure("https://a.com/x", FailureKind::TooManyRequests);
        let json = serde_json::to_string(&limits).unwrap();
        let back: HostLimits = serde_json::from_str(&json).unwrap();
        assert_eq!(back, limits);
    }
}
