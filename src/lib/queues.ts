/**
 * 多队列 + 调度（MDM 路线 A，前端调度层）。
 *
 * 设计取舍：引擎已有全局 max_active 并发槽与 500ms tick，但任务模型无"队列"概念。
 * 为不动已验证的引擎核心（beta.2 全绿），队列作为前端组织维度 + 调度器，
 * 通过现有 backend.pause/resume 命令落实"按时启停 / 队列并发上限 / 失败重试"。
 * 队列元数据与任务归属持久化在 localStorage，重启后由调度器重新应用。
 */

import type { Task } from "./types";

export const DEFAULT_QUEUE_ID = "default";

export interface Queue {
  id: string;
  name: string;
  /** 该队列允许同时运行的任务数（0 = 跟随引擎全局，不额外限制） */
  maxActive: number;
  /** 每天允许下载的开始时间（本地小时 0-23，含）；null 表示不限 */
  startHour: number | null;
  /** 每天允许下载的结束时间（本地小时 0-23，不含）；null 表示不限。跨零点用 startHour>endHour 表达。 */
  endHour: number | null;
  /** 失败后自动重试次数（0 = 不重试） */
  retryOnFail: number;
  /** 队列是否启用（关闭时该队列任务全部暂停） */
  enabled: boolean;
  color: string;
  createdAt: number;
}

export interface QueuesConfig {
  queues: Queue[];
  /** taskId -> queueId，缺省的任务归 default */
  assignment: Record<string, string>;
  /** 失败重试计数：taskId -> 已重试次数（成功完成后清除） */
  retries: Record<string, number>;
}

const STORAGE_KEY = "fluxdl:queues";

const COLORS = ["#286EDC", "#0F766E", "#6D28D9", "#DB2777", "#EA580C", "#0891B2"];

export function defaultQueue(): Queue {
  return {
    id: DEFAULT_QUEUE_ID,
    name: "默认队列",
    maxActive: 0,
    startHour: null,
    endHour: null,
    retryOnFail: 0,
    enabled: true,
    color: COLORS[0],
    createdAt: Date.now(),
  };
}

export function defaultQueuesConfig(): QueuesConfig {
  return { queues: [defaultQueue()], assignment: {}, retries: {} };
}

function sanitizeQueue(raw: unknown, index: number): Queue | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.id !== "string" || typeof q.name !== "string") return null;
  const hour = (v: unknown): number | null =>
    typeof v === "number" && v >= 0 && v <= 23 ? Math.floor(v) : null;
  const count = (v: unknown): number =>
    typeof v === "number" && v >= 0 && v <= 64 ? Math.floor(v) : 0;
  return {
    id: q.id.slice(0, 64),
    name: q.name.slice(0, 40) || `队列 ${index + 1}`,
    maxActive: count(q.maxActive),
    startHour: hour(q.startHour),
    endHour: hour(q.endHour),
    retryOnFail: count(q.retryOnFail),
    enabled: q.enabled !== false,
    color: typeof q.color === "string" && /^#[0-9a-fA-F]{6}$/.test(q.color) ? q.color : COLORS[index % COLORS.length],
    createdAt: typeof q.createdAt === "number" ? q.createdAt : Date.now(),
  };
}

export function readQueuesConfig(): QueuesConfig {
  const base = defaultQueuesConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const obj = JSON.parse(raw) as Partial<QueuesConfig>;
    const queues = (Array.isArray(obj.queues) ? obj.queues : [])
      .map(sanitizeQueue)
      .filter((q): q is Queue => q !== null);
    // 默认队列必须存在且不可删除
    if (!queues.some((q) => q.id === DEFAULT_QUEUE_ID)) queues.unshift(defaultQueue());
    const known = new Set(queues.map((q) => q.id));
    const assignment: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.assignment ?? {})) {
      if (typeof v === "string" && known.has(v)) assignment[k] = v;
    }
    const retries: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj.retries ?? {})) {
      if (typeof v === "number" && v >= 0) retries[k] = Math.floor(v);
    }
    return { queues, assignment, retries };
  } catch {
    return base;
  }
}

export function saveQueuesConfig(cfg: QueuesConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

export function newQueue(name: string, existing: Queue[]): Queue {
  return {
    id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim().slice(0, 40) || `队列 ${existing.length + 1}`,
    maxActive: 0,
    startHour: null,
    endHour: null,
    retryOnFail: 0,
    enabled: true,
    color: COLORS[existing.length % COLORS.length],
    createdAt: Date.now(),
  };
}

/** 任务归属的队列 id（未知 id 回落到 default） */
export function queueOfTask(cfg: QueuesConfig, taskId: string): string {
  const id = cfg.assignment[taskId];
  return id && cfg.queues.some((q) => q.id === id) ? id : DEFAULT_QUEUE_ID;
}

export function tasksInQueue(cfg: QueuesConfig, tasks: Task[], queueId: string): Task[] {
  return tasks.filter((t) => queueOfTask(cfg, t.id) === queueId);
}

/** 当前本地时间是否落在该队列的允许时段内。 */
export function queueInWindow(queue: Queue, now: Date): boolean {
  if (queue.startHour === null || queue.endHour === null) return true;
  const h = now.getHours();
  if (queue.startHour === queue.endHour) return true;
  if (queue.startHour < queue.endHour) return h >= queue.startHour && h < queue.endHour;
  // 跨零点：22:00-06:00
  return h >= queue.startHour || h < queue.endHour;
}

export interface ScheduleDecision {
  /** 应该恢复的任务 id（仅限调度器此前暂停过的） */
  resume: string[];
  /** 应该暂停的任务 id（时段外/队列关闭/超并发） */
  pause: string[];
  /** 应该重试的任务 id（失败且未超次数） */
  retry: string[];
  /** 需要加入"调度暂停"集合的 taskId（下一次 tick 才会恢复这些） */
  holdAdd: string[];
  /** 需要从"调度暂停"集合移除的 taskId */
  holdRemove: string[];
}

/** 队列是否配置了需要调度器介入的约束（默认队列无任何约束 → 完全不干预，尊重手动暂停）。 */
export function queueIsManaged(q: Queue): boolean {
  return !q.enabled || q.startHour !== null || q.maxActive > 0 || q.retryOnFail > 0;
}

/**
 * 纯调度决策：输入任务快照 + 队列配置 + 当前时间 + 调度暂停集合，输出要执行的动作。
 *
 * 关键约束：调度器只恢复"由自己暂停"的任务（held 集合内），绝不碰用户手动暂停的任务，
 * 避免"暂停后 1 秒又被自动恢复"的惊讶行为。默认队列（无约束）完全不纳入调度。
 * 不产生副作用，便于单测。
 */
export function planSchedule(
  cfg: QueuesConfig,
  tasks: Task[],
  now: Date,
  held: ReadonlySet<string>,
): ScheduleDecision {
  const decision: ScheduleDecision = { resume: [], pause: [], retry: [], holdAdd: [], holdRemove: [] };
  const byId = new Map(cfg.queues.map((q) => [q.id, q]));
  const managed = new Map<string, boolean>();
  const capacity = new Map<string, number>();
  const running = new Map<string, number>();

  for (const q of cfg.queues) {
    managed.set(q.id, queueIsManaged(q));
    const allowed = q.enabled && queueInWindow(q, now);
    capacity.set(q.id, allowed ? (q.maxActive === 0 ? Infinity : q.maxActive) : 0);
    running.set(q.id, 0);
  }

  const isRunning = (t: Task) =>
    t.status === "downloading" || t.status === "connecting" || t.status === "queued";

  // 先统计各队列运行数 + 收集失败重试候选
  const retryCandidates: Array<{ task: Task; q: Queue }> = [];
  for (const task of tasks) {
    const q = byId.get(queueOfTask(cfg, task.id)) ?? defaultQueue();
    if (isRunning(task)) running.set(q.id, (running.get(q.id) ?? 0) + 1);
    if (task.status === "failed" && q.retryOnFail > 0 && (cfg.retries[task.id] ?? 0) < q.retryOnFail) {
      retryCandidates.push({ task, q });
    }
  }

  for (const task of tasks) {
    if (task.pendingApproval) continue; // 审核闸门管辖
    const q = byId.get(queueOfTask(cfg, task.id)) ?? defaultQueue();
    if (!managed.get(q.id)) continue; // 无约束队列：完全不动
    const cap = capacity.get(q.id) ?? 0;
    const isHeld = held.has(task.id);

    if (isRunning(task)) {
      // 超额或无名额：暂停并打标记（等时段恢复/名额空出后再由本调度器恢复）
      if (cap === 0 || (cap !== Infinity && (running.get(q.id) ?? 0) > cap)) {
        decision.pause.push(task.id);
        decision.holdAdd.push(task.id);
        running.set(q.id, (running.get(q.id) ?? 0) - 1);
      }
    } else if (task.status === "paused" && isHeld) {
      // 只恢复调度器自己暂停过的任务
      if (cap > 0 && (cap === Infinity || (running.get(q.id) ?? 0) < cap)) {
        decision.resume.push(task.id);
        decision.holdRemove.push(task.id);
        running.set(q.id, (running.get(q.id) ?? 0) + 1);
      }
    }
  }

  // 失败重试：受队列名额约束
  for (const { task, q } of retryCandidates) {
    if (!queueInWindow(q, now)) continue;
    const cap = capacity.get(q.id) ?? 0;
    if (cap > 0 && (cap === Infinity || (running.get(q.id) ?? 0) < cap)) {
      decision.retry.push(task.id);
      running.set(q.id, (running.get(q.id) ?? 0) + 1);
    }
  }

  return decision;
}
