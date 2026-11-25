//! 动态分段规划器（对标 MDM 的核心调度能力）。
//!
//! 职责边界：本模块只做**纯决策**——给定各分段的进度快照，判断要不要再切一段、
//! 以及切在哪里。所有 IO、spawn、`entry.segments` 的写入都留在 http.rs。
//! 这样调度策略可以确定性单测，不必起 HTTP 服务器。
//!
//! 相对旧的 `rebalance_laggard` 的三点增强：
//! 1. **剩余优先**：挑「剩余字节最大」的段对半拆，而不是「落后最多」的段。
//!    落后多可能只是段本身大；真正拖住任务尾巴的是绝对剩余量最大的段。
//! 2. **4096 对齐**：新段起点对齐到 4096 边界，让两条连接的写盘落在不同块，
//!    减少同一 4K 块被并发写造成的写放大与伪共享。
//! 3. **claim/commit 语义**：`SplitPlan` 明确携带被拆段的新边界与派生段范围，
//!    由调用方一次性原子写入 `entry.segments`；段用 `index` 作为身份，
//!    一个计划只 claim 一个未完成段、commit 一个新段，边界互不重叠。

/// 对齐粒度：新段起点对齐到 4096 字节边界。
pub const SPLIT_ALIGN: u64 = 4096;
/// 个段剩余至少这么多字节才值得再起连接（否则切分开销 > 收益）。
pub const SPLIT_MIN_REMAIN: u64 = 8 * 1024 * 1024;
/// 派生段本身至少要这么大，避免出现一堆碎片段。
pub const SPLIT_MIN_CHILD: u64 = 2 * 1024 * 1024;
/// 单个任务最多派生次数，防止无限细分导致段数与连接数膨胀。
pub const SPLIT_MAX_COUNT: usize = 12;

/// 分段进度快照。由 http.rs 从 `entry.segments` 拷贝，纯值类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentSnapshot {
    pub index: usize,
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
    pub done: bool,
}

impl SegmentSnapshot {
    pub fn length(&self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
    pub fn remaining(&self) -> u64 {
        self.length().saturating_sub(self.downloaded)
    }
}

/// 一次切分计划：把 `target` 段的下载范围一分为二。
///
/// 调用方须按此计划原子更新：
/// - `segments[target].end = cut`（原段只负责到切点）
/// - 追加 `SegmentView { index: new_index, start: cut+1, end: old_end }`
/// 两段写绝对偏移的不同区间，摘要各算各的，回读校验按位置对齐，故不会互相覆盖。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitPlan {
    pub target: usize,
    pub cut: u64,
    pub new_index: usize,
    pub new_start: u64,
    pub new_end: u64,
}

/// 把 `value` 向上取整到 `align` 的倍数。`align` 必须是 2 的幂。
fn align_up(value: u64, align: u64) -> u64 {
    (value + align - 1) & !(align - 1)
}

/// 从快照里挑一个段切分，返回 4096 对齐的切分计划。
///
/// 判据：
/// - 派生次数未达上限；
/// - 段未完成、剩余 >= `SPLIT_MIN_REMAIN`；
/// - 对半切后，原段与派生段都 >= `SPLIT_MIN_CHILD`（否则不值得切）。
/// 在所有合格段里选**剩余最大**的那个（拖尾巴最狠的先拆）。
///
/// 纯函数、无 IO，可确定性单测。
pub fn pick_split(segs: &[SegmentSnapshot], splits_used: usize) -> Option<SplitPlan> {
    if splits_used >= SPLIT_MAX_COUNT {
        return None;
    }
    // (index, remaining, new_start, cut)
    let mut best: Option<(usize, u64, u64, u64)> = None;
    for seg in segs {
        if seg.done {
            continue;
        }
        let remaining = seg.remaining();
        if remaining < SPLIT_MIN_REMAIN {
            continue;
        }
        let pos = seg.start.saturating_add(seg.downloaded);
        // 目标切点：从当前写入位置起，把剩余区间对半。
        let half = pos.saturating_add(remaining / 2);
        let new_start = align_up(half, SPLIT_ALIGN);
        // 派生段起点必须严格在原段范围内，且不能落在已写字节之前。
        if new_start <= pos || new_start > seg.end {
            continue;
        }
        let cut = new_start - 1;
        let left = cut.saturating_sub(seg.start).saturating_add(1);
        let right = seg.end.saturating_sub(new_start).saturating_add(1);
        if left < SPLIT_MIN_CHILD || right < SPLIT_MIN_CHILD {
            continue;
        }
        // 选剩余最大的段；并列时取 index 小的，保证结果确定。
        let better = match best {
            None => true,
            Some((best_idx, best_rem, _, _)) => {
                remaining > best_rem || (remaining == best_rem && seg.index < best_idx)
            }
        };
        if better {
            best = Some((seg.index, remaining, new_start, cut));
        }
    }
    best.map(|(target, _, new_start, cut)| {
        let old_end = segs[target].end;
        SplitPlan {
            target,
            cut,
            new_index: segs.len(),
            new_start,
            new_end: old_end,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(index: usize, start: u64, end: u64, downloaded: u64, done: bool) -> SegmentSnapshot {
        SegmentSnapshot { index, start, end, downloaded, done }
    }

    #[test]
    fn align_up_rounds_to_4096() {
        assert_eq!(align_up(0, SPLIT_ALIGN), 0);
        assert_eq!(align_up(1, SPLIT_ALIGN), 4096);
        assert_eq!(align_up(4095, SPLIT_ALIGN), 4096);
        assert_eq!(align_up(4096, SPLIT_ALIGN), 4096);
        assert_eq!(align_up(4097, SPLIT_ALIGN), 8192);
    }

    #[test]
    fn picks_largest_remaining_segment() {
        // 段 0 剩余 24MB，段 1 剩余 8MB：应拆段 0。
        let segs = vec![
            seg(0, 0, 24 * 1024 * 1024 - 1, 0, false),
            seg(1, 24 * 1024 * 1024, 32 * 1024 * 1024 - 1, 0, false),
        ];
        let plan = pick_split(&segs, 0).unwrap();
        assert_eq!(plan.target, 0);
        assert_eq!(plan.new_index, 2);
        assert_eq!(plan.new_start % SPLIT_ALIGN, 0, "新段起点须 4096 对齐");
        assert_eq!(plan.cut, plan.new_start - 1);
        assert_eq!(plan.new_end, segs[0].end);
        // 切分后两段各自覆盖原区间的一部分，不重叠、不留洞。
        assert!(plan.new_start > 0 && plan.new_start <= segs[0].end);
    }

    #[test]
    fn done_and_small_segments_are_skipped() {
        let segs = vec![
            seg(0, 0, 100 * 1024 * 1024 - 1, 100 * 1024 * 1024, true), // done
            seg(1, 100 * 1024 * 1024, 101 * 1024 * 1024 - 1, 0, false), // 1MB < 阈值
        ];
        assert!(pick_split(&segs, 0).is_none());
    }

    #[test]
    fn respects_split_cap() {
        let segs = vec![seg(0, 0, 100 * 1024 * 1024 - 1, 0, false)];
        assert!(pick_split(&segs, SPLIT_MAX_COUNT).is_none());
        assert!(pick_split(&segs, SPLIT_MAX_COUNT - 1).is_some());
    }

    #[test]
    fn segments_near_end_not_split_into_tiny_child() {
        // 剩余 10MB，对半后派生段 5MB >= 2MB：可切。
        let ok = vec![seg(0, 0, 10 * 1024 * 1024 - 1, 0, false)];
        assert!(pick_split(&ok, 0).is_some());
        // 剩余量低于阈值（8MB）的段不应切分。
        let small = vec![seg(0, 0, SPLIT_MIN_REMAIN - 2, 0, false)];
        assert_eq!(small[0].remaining(), SPLIT_MIN_REMAIN - 1);
        assert!(pick_split(&small, 0).is_none(), "低于阈值的段不应切分");
    }

    #[test]
    fn split_boundaries_never_overlap() {
        let segs = vec![seg(0, 0, 64 * 1024 * 1024 - 1, 4 * 1024 * 1024, false)];
        let plan = pick_split(&segs, 0).unwrap();
        // 原段 [start, cut]，新段 [new_start, new_end]，cut+1 == new_start。
        assert_eq!(plan.cut + 1, plan.new_start);
        assert_eq!(plan.new_end, segs[0].end);
        assert!(plan.cut >= segs[0].start);
    }
}
