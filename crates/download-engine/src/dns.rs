//! 多 IP 竞速优选 DNS 解析器（参考 MDM `dns.rs`，零新增外部依赖）：
//!
//! 当下载域名（如 GitHub Releases / ModelScope / HuggingFace / 大型 CDN）解析出
//! 多个 IP 时，默认顺序连接若第一个 IP 超时或丢包，每条连接都会白等 15~20 秒。
//! 本解析器对多 IP 目标并发发起短超时 TCP 竞速，把最先连通的 IP 排到最前并缓存
//! 5 分钟，死节点自动靠后；单 IP、本地回环地址直接透传，不影响本地测试与单节点站点。

use parking_lot::Mutex;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::task::JoinSet;

/// 胜出 IP 的缓存有效期。
const CACHE_TTL: Duration = Duration::from_secs(300);
/// 单次多 IP TCP 竞速的超时上限（不拖慢首包）。
const RACE_TIMEOUT: Duration = Duration::from_secs(3);
/// 每次最多并发竞速的候选 IP 数量。
const MAX_CANDIDATES: usize = 6;
/// 缓存最大域名条目数，防止长期运行无限增长。
const MAX_CACHE_ENTRIES: usize = 256;

#[derive(Clone)]
struct CachedWinner {
    ip: IpAddr,
    expires_at: Instant,
}

pub struct FastDnsResolver {
    cache: Arc<Mutex<HashMap<String, CachedWinner>>>,
}

impl FastDnsResolver {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for FastDnsResolver {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局共享的多 IP 竞速解析器实例，跨任务复用优选结果。
pub fn shared_resolver() -> Arc<FastDnsResolver> {
    static INSTANCE: OnceLock<Arc<FastDnsResolver>> = OnceLock::new();
    INSTANCE.get_or_init(|| Arc::new(FastDnsResolver::new())).clone()
}

/// 将指定胜出 IP 提升到候选列表首位（纯函数，便于单测）。
pub fn promote_ip(addrs: &mut Vec<SocketAddr>, winner: IpAddr) {
    if let Some(idx) = addrs.iter().position(|a| a.ip() == winner) {
        if idx > 0 {
            let item = addrs.remove(idx);
            addrs.insert(0, item);
        }
    }
}

fn is_local_or_special(host: &str, addrs: &[SocketAddr]) -> bool {
    let h = host.to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".local") || h.ends_with(".localhost") {
        return true;
    }
    addrs.iter().all(|a| a.ip().is_loopback())
}

async fn race_fastest_ip(addrs: &[SocketAddr]) -> Option<IpAddr> {
    let mut set: JoinSet<Option<IpAddr>> = JoinSet::new();
    for (idx, addr) in addrs.iter().take(MAX_CANDIDATES).enumerate() {
        let target = SocketAddr::new(addr.ip(), 443);
        // 轻微错峰（RFC 8305 思路），避免瞬间 SYN 风暴同时仍以最快连通者胜出。
        let stagger = Duration::from_millis((idx as u64) * 35);
        set.spawn(async move {
            if !stagger.is_zero() {
                tokio::time::sleep(stagger).await;
            }
            match tokio::time::timeout(RACE_TIMEOUT, tokio::net::TcpStream::connect(target)).await {
                Ok(Ok(_stream)) => Some(target.ip()),
                _ => None,
            }
        });
    }

    let deadline = tokio::time::sleep(RACE_TIMEOUT);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => {
                set.abort_all();
                return None;
            }
            res = set.join_next() => {
                match res {
                    Some(Ok(Some(ip))) => {
                        set.abort_all();
                        return Some(ip);
                    }
                    Some(_) => continue,
                    None => return None,
                }
            }
        }
    }
}

impl Resolve for FastDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let cache = self.cache.clone();
        Box::pin(async move {
            let host = name.as_str().to_string();
            let resolved = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let mut addrs: Vec<SocketAddr> = Vec::new();
            for addr in resolved {
                if !addrs.iter().any(|a| a.ip() == addr.ip()) {
                    addrs.push(addr);
                }
            }

            if addrs.len() > 1 && !is_local_or_special(&host, &addrs) {
                let now = Instant::now();
                let cached_ip = {
                    let guard = cache.lock();
                    guard
                        .get(&host)
                        .filter(|c| c.expires_at > now)
                        .map(|c| c.ip)
                };

                if let Some(ip) = cached_ip {
                    promote_ip(&mut addrs, ip);
                } else if let Some(winner) = race_fastest_ip(&addrs).await {
                    promote_ip(&mut addrs, winner);
                    let mut guard = cache.lock();
                    if guard.len() >= MAX_CACHE_ENTRIES {
                        guard.retain(|_, v| v.expires_at > now);
                    }
                    guard.insert(
                        host,
                        CachedWinner {
                            ip: winner,
                            expires_at: now + CACHE_TTL,
                        },
                    );
                }
            }

            let iter: Addrs = Box::new(addrs.into_iter());
            Ok(iter)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddrV4};

    #[test]
    fn promote_ip_moves_winner_to_front() {
        let a = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(1, 1, 1, 1), 0));
        let b = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(8, 8, 8, 8), 0));
        let c = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(9, 9, 9, 9), 0));
        let mut list = vec![a, b, c];
        promote_ip(&mut list, IpAddr::V4(Ipv4Addr::new(9, 9, 9, 9)));
        assert_eq!(list, vec![c, a, b]);
    }

    #[test]
    fn local_addresses_skip_race() {
        let local = vec![SocketAddr::V4(SocketAddrV4::new(
            Ipv4Addr::new(127, 0, 0, 1),
            0,
        ))];
        assert!(is_local_or_special("localhost", &local));
        assert!(is_local_or_special("example.com", &local));
    }
}
