import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import { planSchedule, queueIsManaged } from "../lib/queues";

/**
 * 队列调度器：每秒评估一次，按队列的启用/时段/并发/重试配置执行动作。
 * 只恢复"调度器自己暂停"的任务（held 集合），绝不覆盖用户手动暂停。
 * 默认队列无约束 → 完全不干预。所有命令走现有后端 pause/resume/retry。
 */
export function useQueueScheduler() {
  const running = useRef(false);

  useEffect(() => {
    const tick = async () => {
      if (running.current) return;
      const state = useStore.getState();
      // 没有任何被管理的队列时，直接跳过，零开销。
      if (!state.queues.queues.some(queueIsManaged)) {
        if (state.scheduleHeld.length) state.setScheduleHeld([]);
        return;
      }
      running.current = true;
      try {
        const held = new Set(state.scheduleHeld);
        const decision = planSchedule(state.queues, state.tasks, new Date(), held);

        // 暂停：先打标记再执行，避免下一 tick 空窗期被误判恢复
        for (const id of decision.pause) {
          try {
            await backend.pause(id);
            held.add(id);
          } catch {
            // 单个任务失败不影响其他
          }
        }
        // 恢复：只针对 held 内的任务
        for (const id of decision.resume) {
          try {
            await backend.resume(id);
            held.delete(id);
          } catch {
            // ignore
          }
        }
        // 重试：失败自动重试，累加计数
        if (decision.retry.length) {
          const retries = { ...state.queues.retries };
          for (const id of decision.retry) {
            try {
              await backend.retry(id);
              retries[id] = (retries[id] ?? 0) + 1;
            } catch {
              // ignore
            }
          }
          state.setQueues({ ...state.queues, retries });
        }

        // 任务完成后清理其 held / retry 计数，避免集合无限增长
        const alive = new Set(state.tasks.map((t) => t.id));
        const nextHeld = [...held].filter((id) => alive.has(id));
        const nextRetries = Object.fromEntries(
          Object.entries(state.queues.retries).filter(
            ([id]) => alive.has(id) && state.tasks.find((t) => t.id === id)?.status !== "completed",
          ),
        );
        if (
          nextHeld.length !== state.scheduleHeld.length ||
          JSON.stringify(nextRetries) !== JSON.stringify(state.queues.retries)
        ) {
          state.setScheduleHeld(nextHeld);
          state.setQueues({ ...state.queues, retries: nextRetries });
        }
      } finally {
        running.current = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => window.clearInterval(timer);
  }, []);
}
