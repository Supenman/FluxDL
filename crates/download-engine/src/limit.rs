use std::time::{Duration, Instant};

use parking_lot::Mutex;

#[derive(Default)]
struct State {
    limit: Option<u64>,
    next: Option<Instant>,
}

/// Per-task / global pacing limiter. `None` means unlimited.
#[derive(Default)]
pub struct RateLimiter {
    state: Mutex<State>,
}

impl RateLimiter {
    pub fn new(limit: Option<u64>) -> Self {
        Self {
            state: Mutex::new(State {
                limit,
                next: None,
            }),
        }
    }

    pub fn set_limit(&self, limit: Option<u64>) {
        let mut st = self.state.lock();
        st.limit = limit.filter(|v| *v > 0);
        st.next = None;
    }

    pub fn limit(&self) -> Option<u64> {
        self.state.lock().limit
    }

    /// Reserve `bytes` of throughput. Sleeps only when the caller is ahead of
    /// schedule, which keeps the long-run average equal to the configured rate.
    pub async fn acquire(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let wait = {
            let mut st = self.state.lock();
            match st.limit {
                None => {
                    st.next = None;
                    None
                }
                Some(rate) => {
                    let now = Instant::now();
                    let start = st.next.map(|t| t.max(now)).unwrap_or(now);
                    let cost = Duration::from_secs_f64(bytes as f64 / rate.max(1) as f64);
                    st.next = Some(start + cost);
                    (start > now).then(|| start - now)
                }
            }
        };
        if let Some(d) = wait {
            tokio::time::sleep(d).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unlimited_is_instant() {
        let l = RateLimiter::new(None);
        let t = Instant::now();
        l.acquire(1024).await;
        assert!(t.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn paces_large_chunks() {
        let l = RateLimiter::new(Some(1000));
        let t = Instant::now();
        l.acquire(1000).await; // first is free
        l.acquire(1000).await; // must wait ~1s
        assert!(t.elapsed() >= Duration::from_millis(800));
    }
}
