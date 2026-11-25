/**
 * 数据表列自定义配置（MDM 路线 A）：列顺序、显隐、宽度、过滤。
 * 全部落在 localStorage，与任务数据解耦——即便后端任务结构变化也不影响视图配置。
 * 白名单校验：列 key 必须在定义表内，宽度夹在合理区间，避免坏配置把表格撑坏。
 */
import type { SortKey, Task } from "./types";

export type ColumnKey =
  | "name"
  | "status"
  | "size"
  | "progress"
  | "eta"
  | "rate"
  | "added"
  | "domain"
  | "category"
  | "connections"
  | "speedLimit";

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** 该列点击表头时的排序键；null 表示不可排序 */
  sort: SortKey | null;
  /** 默认是否显示 */
  defaultVisible: boolean;
  /** 默认宽度（px） */
  defaultWidth: number;
  minWidth: number;
  /** 是否可隐藏（文件名列固定显示） */
  lockable: boolean;
  align?: "left" | "right";
}

/** 列定义表。顺序即默认显示顺序；新增列只需在此追加，读配置时会自动补默认值。 */
export const COLUMN_DEFS: ColumnDef[] = [
  { key: "name", label: "文件名", sort: "name", defaultVisible: true, defaultWidth: 300, minWidth: 160, lockable: false },
  { key: "status", label: "状态", sort: "status", defaultVisible: true, defaultWidth: 92, minWidth: 72, lockable: true },
  { key: "size", label: "大小", sort: "size", defaultVisible: true, defaultWidth: 88, minWidth: 64, lockable: true, align: "right" },
  { key: "progress", label: "进度", sort: "progress", defaultVisible: true, defaultWidth: 132, minWidth: 96, lockable: true },
  { key: "eta", label: "剩余", sort: "eta", defaultVisible: true, defaultWidth: 88, minWidth: 64, lockable: true, align: "right" },
  { key: "rate", label: "速率", sort: "rate", defaultVisible: true, defaultWidth: 92, minWidth: 68, lockable: true, align: "right" },
  { key: "added", label: "添加时间", sort: "added", defaultVisible: true, defaultWidth: 104, minWidth: 84, lockable: true },
  { key: "domain", label: "来源", sort: "domain", defaultVisible: true, defaultWidth: 150, minWidth: 90, lockable: true },
  { key: "category", label: "类型", sort: null, defaultVisible: false, defaultWidth: 76, minWidth: 60, lockable: true },
  { key: "connections", label: "连接", sort: null, defaultVisible: false, defaultWidth: 68, minWidth: 56, lockable: true, align: "right" },
  { key: "speedLimit", label: "限速", sort: null, defaultVisible: false, defaultWidth: 88, minWidth: 72, lockable: true, align: "right" },
];

const DEF_BY_KEY = new Map(COLUMN_DEFS.map((d) => [d.key, d]));

export interface ColumnState {
  key: ColumnKey;
  visible: boolean;
  width: number;
}

export interface ColumnsConfig {
  order: ColumnKey[];
  states: Record<string, { visible: boolean; width: number }>;
  /** 每列的文本过滤值（表头漏斗输入） */
  filters: Record<string, string>;
}

const STORAGE_KEY = "fluxdl:columns";

export function defaultColumnsConfig(): ColumnsConfig {
  const states: ColumnsConfig["states"] = {};
  for (const d of COLUMN_DEFS) {
    states[d.key] = { visible: d.defaultVisible, width: d.defaultWidth };
  }
  return { order: COLUMN_DEFS.map((d) => d.key), states, filters: {} };
}

export function readColumnsConfig(): ColumnsConfig {
  const base = defaultColumnsConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const obj = JSON.parse(raw) as Partial<ColumnsConfig>;
    // 顺序：只保留白名单 key，去重；缺失的列按默认顺序补到末尾。
    const seen = new Set<ColumnKey>();
    const order: ColumnKey[] = [];
    for (const k of Array.isArray(obj.order) ? obj.order : []) {
      if (DEF_BY_KEY.has(k) && !seen.has(k)) {
        order.push(k);
        seen.add(k);
      }
    }
    for (const d of COLUMN_DEFS) {
      if (!seen.has(d.key)) {
        order.push(d.key);
        seen.add(d.key);
      }
    }
    const states: ColumnsConfig["states"] = {};
    for (const d of COLUMN_DEFS) {
      const saved = obj.states?.[d.key];
      const width = saved && Number.isFinite(saved.width)
        ? Math.min(480, Math.max(d.minWidth, Math.round(saved.width)))
        : d.defaultWidth;
      const visible = d.lockable
        ? (saved ? Boolean(saved.visible) : d.defaultVisible)
        : true; // 文件名列强制显示
      states[d.key] = { visible, width };
    }
    const filters: ColumnsConfig["filters"] = {};
    for (const d of COLUMN_DEFS) {
      const v = obj.filters?.[d.key];
      if (typeof v === "string") filters[d.key] = v.slice(0, 120);
    }
    return { order, states, filters };
  } catch {
    return base;
  }
}

export function saveColumnsConfig(cfg: ColumnsConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

/** 当前可见列（按用户顺序） */
export function visibleColumns(cfg: ColumnsConfig): ColumnDef[] {
  const out: ColumnDef[] = [];
  for (const key of cfg.order) {
    const def = DEF_BY_KEY.get(key);
    if (def && cfg.states[key]?.visible) out.push(def);
  }
  return out;
}

/** 按列过滤任务：任一列有过滤值时，全部条件都要满足（AND）。 */
export function filterByColumns(tasks: Task[], cfg: ColumnsConfig, categoryOf: (t: Task) => string): Task[] {
  const active = Object.entries(cfg.filters).filter(([, v]) => v && v.trim());
  if (active.length === 0) return tasks;
  const q = active.map(([k, v]) => [k, v.trim().toLowerCase()] as const);
  return tasks.filter((task) =>
    q.every(([key, value]) => {
      let text: string;
      switch (key) {
        case "name": text = task.filename; break;
        case "status": text = task.status; break;
        case "size": text = String(task.totalBytes); break;
        case "progress": text = task.totalBytes ? String(Math.floor((task.downloadedBytes / task.totalBytes) * 100)) : "0"; break;
        case "eta": text = task.etaSeconds == null ? "" : String(task.etaSeconds); break;
        case "rate": text = String(task.speedBps); break;
        case "added": text = new Date(task.createdAt).toLocaleString("zh-CN"); break;
        case "domain": text = task.domain; break;
        case "category": text = categoryOf(task); break;
        case "connections": text = String(task.connections); break;
        case "speedLimit": text = task.speedLimit ? String(task.speedLimit) : ""; break;
        default: text = "";
      }
      return text.toLowerCase().includes(value);
    }),
  );
}
