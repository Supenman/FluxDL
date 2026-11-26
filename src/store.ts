import { create } from "zustand";
import type {
  EngineOptions,
  FileCategory,
  Filter,
  LogLine,
  SortKey,
  StagedUpdate,
  Task,
  TaskStatus,
  UpdateCheck,
  ViewMode,
  PowerAction,
} from "./lib/types";
import { uid } from "./lib/format";
import { readAccent, saveAccent, type AccentColors } from "./lib/theme";
import {
  readQueuesConfig,
  saveQueuesConfig,
  type QueuesConfig,
} from "./lib/queues";

export type Theme = "dark" | "light" | "system";
export type Tone = "info" | "success" | "error";

export interface Toast {
  id: string;
  message: string;
  tone: Tone;
}

export const defaultEngineOptions: EngineOptions = {
  saveDir: "C:\\Users\\Alex\\Downloads",
  organizeByCategory: false,
  maxActive: 3,
  connections: 0, // 自动：引擎按文件体积决定连接数
  globalSpeedLimit: null,
  proxy: null,
  useSystemProxy: true,
  userAgent: "FluxDL/0.1 (Windows)",
  ytDlpPath: "yt-dlp",
  ffmpegPath: null,
  // 缺失时整体 setEngineOptions 会把后端已配置的 aria2c 路径清成 null，
  // 引擎随即探测不到 aria2 → 静默回退单连接。默认值必须与 EngineOptions 字段齐备。
  aria2Path: null,
  autoUpdateYtDlp: true,
  clipboardWatch: true,
  closeToTray: true,
  openFolderAfter: false,
  approveCapturedDownloads: false,
};

function readTheme(): Theme {
  try {
    const raw = localStorage.getItem("fluxdl:theme");
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // ignore
  }
  return "dark";
}

function readCompact(): boolean {
  try {
    return localStorage.getItem("fluxdl:compact") === "1";
  } catch {
    return false;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // ignore
  }
  return fallback;
}

function readManualOrder(): string[] {
  try {
    const raw = localStorage.getItem("fluxdl:manualOrder");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

function readDirection(): "ltr" | "rtl" {
  try {
    return localStorage.getItem("fluxdl:direction") === "rtl" ? "rtl" : "ltr";
  } catch {
    // ignore
  }
  return "ltr";
}

function readViewMode(): ViewMode {
  try {
    const saved = localStorage.getItem("fluxdl:viewMode");
    // 用户显式选过就尊重；新装用户默认多列数据表（更接近 IDM/MDM 的信息密度）。
    if (saved === "table" || saved === "card") return saved;
  } catch {
    // ignore
  }
  return "table";
}

/** 界面缩放：允许 100%~200%，夹取并量化到 25% 档，异常回退 1。 */
export function readUiScale(): number {
  try {
    const raw = localStorage.getItem("fluxdl:uiScale");
    const n = raw ? Number(raw) : 1;
    if (Number.isFinite(n) && n >= 1 && n <= 2) return Math.round(n * 4) / 4;
  } catch {
    // ignore
  }
  return 1;
}

interface AppStore {
  tasks: Task[];
  selectedId: string | null;
  filter: Filter;
  query: string;
  sort: SortKey;
  /** 手动排序时的任务 id 顺序（拖拽排序写入，localStorage 持久化） */
  manualOrder: string[];
  settings: EngineOptions;
  settingsLoaded: boolean;
  theme: Theme;
  /** 紧凑多列视图：在任务行显示添加时间/来源/平均速度等额外列 */
  compact: boolean;
  /** 任务列表呈现方式：卡片（默认）或 MDM 式多列数据表 */
  viewMode: ViewMode;
  /** 自定义强调色（预设或导入），null 表示用默认经典蓝 */
  accent: AccentColors | null;
  /** 界面缩放倍率（无障碍：支持到 200%），作用于整个应用外壳 */
  uiScale: number;
  /** 界面方向：ltr（默认）/ rtl（镜像布局，适配从右到左语言） */
  direction: "ltr" | "rtl";
  /** 下载完成/失败时弹系统通知（应用在后台或托盘时尤其有用） */
  notifyOnFinish: boolean;
  /** 下载完成时播放提示音 */
  soundOnFinish: boolean;
  /** 多队列配置 + 任务归属 */
  queues: QueuesConfig;
  /** 当前队列筛选（null = 全部队列） */
  queueFilter: string | null;
  /** 调度器暂停集合：调度器只恢复自己暂停的任务，不碰用户手动暂停 */
  scheduleHeld: string[];
  /** 独立进度窗口显示的任务 id */
  progressId: string | null;
  view: "tasks" | "settings";
  newTaskOpen: boolean;
  newTaskSeed: string;
  commandOpen: boolean;
  clipboardOffer: string | null;
  logs: Record<string, LogLine[]>;
  toasts: Toast[];
  /** 最近一次检查更新的结果；null 表示还没查过。 */
  updateCheck: UpdateCheck | null;
  /** 用户点过「稍后」的版本号；再来更高版本会重新提示。 */
  hiddenUpdateVersion: string | null;
  /** 已下载待重启的版本。 */
  stagedUpdate: StagedUpdate | null;

  setTasks: (tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (id: string) => void;
  select: (id: string | null) => void;
  /**
   * 「键盘光标」与 selectedId 分离：列表用 ↑/↓ 移动光标只改焦点，
   * 按 Enter 才打开详情抽屉。这样才有 IDM/资源管理器式的列表浏览手感。
   */
  focusedId: string | null;
  setFocus: (id: string | null) => void;
  setFilter: (filter: Filter) => void;
  setQuery: (query: string) => void;
  setSort: (sort: SortKey) => void;
  /** 拖拽排序：接收拖拽后的完整 id 顺序，自动切到手动排序并持久化。 */
  reorderTasks: (ids: string[]) => void;
  setSettings: (patch: Partial<EngineOptions>) => void;
  setSettingsLoaded: (loaded: boolean) => void;
  setTheme: (theme: Theme) => void;
  setCompact: (compact: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
  setAccent: (accent: AccentColors | null) => void;
  setUiScale: (scale: number) => void;
  setDirection: (direction: "ltr" | "rtl") => void;
  setNotifyOnFinish: (on: boolean) => void;
  setSoundOnFinish: (on: boolean) => void;
  powerAction: PowerAction;
  setPowerAction: (action: PowerAction) => void;
  setQueues: (cfg: QueuesConfig) => void;
  setQueueFilter: (id: string | null) => void;
  assignTaskQueue: (taskId: string, queueId: string) => void;
  setScheduleHeld: (ids: string[]) => void;
  setProgressId: (id: string | null) => void;
  setView: (view: "tasks" | "settings") => void;
  setNewTaskOpen: (open: boolean, seed?: string) => void;
  setCommandOpen: (open: boolean) => void;
  setClipboardOffer: (url: string | null) => void;
  pushToast: (message: string, tone?: Tone) => void;
  dismissToast: (id: string) => void;
  appendLog: (line: LogLine) => void;
  clearLogs: (taskId: string) => void;
  setUpdateCheck: (check: UpdateCheck | null) => void;
  hideUpdate: (version: string) => void;
  setStagedUpdate: (staged: StagedUpdate | null) => void;
}

const statusOrder: Record<TaskStatus, number> = {
  downloading: 0,
  connecting: 1,
  queued: 2,
  paused: 3,
  failed: 4,
  completed: 5,
};

export const useStore = create<AppStore>((set) => ({
  tasks: [],
  selectedId: null,
  focusedId: null,
  filter: "all",
  query: "",
  sort: "recent",
  manualOrder: readManualOrder(),
  settings: defaultEngineOptions,
  settingsLoaded: false,
  theme: readTheme(),
  compact: readCompact(),
  viewMode: readViewMode(),
  accent: readAccent(),
  uiScale: readUiScale(),
  direction: readDirection(),
  notifyOnFinish: readBool("fluxdl:notifyOnFinish", true),
  soundOnFinish: readBool("fluxdl:soundOnFinish", true),
  powerAction: "none",
  queues: readQueuesConfig(),
  queueFilter: null,
  scheduleHeld: [],
  progressId: null,
  view: "tasks",
  newTaskOpen: false,
  newTaskSeed: "",
  commandOpen: false,
  clipboardOffer: null,
  logs: {},
  toasts: [],
  updateCheck: null,
  hiddenUpdateVersion: null,
  stagedUpdate: null,

  setTasks: (tasks) => set({ tasks }),

  upsertTask: (task) =>
    set((state) => {
      const index = state.tasks.findIndex((t) => t.id === task.id);
      if (index === -1) {
        return { tasks: [task, ...state.tasks] };
      }
      const tasks = state.tasks.slice();
      // Keep active tasks visually grouped on refresh without reordering on
      // every progress tick.
      tasks[index] = task;
      return { tasks };
    }),

  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
      focusedId: state.focusedId === id ? null : state.focusedId,
      progressId: state.progressId === id ? null : state.progressId,
    })),

  select: (id) => set({ selectedId: id }),
  setFocus: (id) => set({ focusedId: id }),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  setSort: (sort) => set({ sort }),
  reorderTasks: (ids) => {
    try {
      localStorage.setItem("fluxdl:manualOrder", JSON.stringify(ids));
    } catch {
      // ignore
    }
    set({ manualOrder: ids, sort: "manual" });
  },

  setSettings: (patch) =>
    set((state) => ({ settings: { ...state.settings, ...patch } })),
  setSettingsLoaded: (loaded) => set({ settingsLoaded: loaded }),

  setPowerAction: (action) => set({ powerAction: action }),

  setTheme: (theme) => {
    try {
      localStorage.setItem("fluxdl:theme", theme);
    } catch {
      // ignore
    }
    set({ theme });
  },

  setCompact: (compact) => {
    try {
      localStorage.setItem("fluxdl:compact", compact ? "1" : "0");
    } catch {
      // ignore
    }
    set({ compact });
  },

  setViewMode: (mode) => {
    try {
      localStorage.setItem("fluxdl:viewMode", mode);
    } catch {
      // ignore
    }
    set({ viewMode: mode });
  },

  setAccent: (accent) => {
    saveAccent(accent);
    set({ accent });
  },

  setUiScale: (scale) => {
    const safe = Math.min(2, Math.max(1, Math.round(scale * 4) / 4));
    try {
      localStorage.setItem("fluxdl:uiScale", String(safe));
    } catch {
      // ignore
    }
    set({ uiScale: safe });
  },

  setDirection: (direction) => {
    try {
      localStorage.setItem("fluxdl:direction", direction);
    } catch {
      // ignore
    }
    set({ direction });
  },

  setNotifyOnFinish: (on) => {
    try {
      localStorage.setItem("fluxdl:notifyOnFinish", on ? "1" : "0");
    } catch {
      // ignore
    }
    set({ notifyOnFinish: on });
  },

  setSoundOnFinish: (on) => {
    try {
      localStorage.setItem("fluxdl:soundOnFinish", on ? "1" : "0");
    } catch {
      // ignore
    }
    set({ soundOnFinish: on });
  },

  setQueues: (queues) => {
    saveQueuesConfig(queues);
    set({ queues });
  },
  setQueueFilter: (queueFilter) => set({ queueFilter }),
  assignTaskQueue: (taskId, queueId) =>
    set((state) => {
      const queues = {
        ...state.queues,
        assignment: { ...state.queues.assignment, [taskId]: queueId },
      };
      saveQueuesConfig(queues);
      return { queues };
    }),
  setScheduleHeld: (scheduleHeld) => set({ scheduleHeld }),

  setProgressId: (progressId) => set({ progressId }),

  setView: (view) => set({ view, selectedId: null, focusedId: null }),

  setNewTaskOpen: (open, seed) =>
    set({
      newTaskOpen: open,
      newTaskSeed: seed !== undefined ? seed : "",
    }),

  setCommandOpen: (open) => set({ commandOpen: open }),
  setClipboardOffer: (url) => set({ clipboardOffer: url }),

  pushToast: (message, tone = "info") =>
    set((state) => ({
      toasts: [
        ...state.toasts.filter((t) => t.message !== message),
        { id: uid(), message, tone },
      ].slice(-3),
    })),

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  setUpdateCheck: (check) => set({ updateCheck: check }),
  hideUpdate: (version) => set({ hiddenUpdateVersion: version }),
  setStagedUpdate: (staged) => set({ stagedUpdate: staged }),

  appendLog: (line) =>
    set((state) => {
      const existing = state.logs[line.taskId] ?? [];
      return {
        logs: {
          ...state.logs,
          [line.taskId]: [...existing, line].slice(-100),
        },
      };
    }),

  clearLogs: (taskId) =>
    set((state) => {
      const logs = { ...state.logs };
      delete logs[taskId];
      return { logs };
    }),
}));

const EXT_CATEGORY: Record<FileCategory, string[]> = {
  video: ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v", "ts", "m3u8", "mpd"],
  document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "epub", "mobi"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "dmg"],
  other: [],
};

/** 按文件名扩展名归类；视频任务（yt-dlp）优先归到 video。 */
export function fileCategory(task: Task): FileCategory {
  if (task.kind === "media") return "video";
  const name = task.filename.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "other";
  const ext = name.slice(dot + 1);
  for (const cat of ["video", "document", "archive"] as FileCategory[]) {
    if (EXT_CATEGORY[cat].includes(ext)) return cat;
  }
  return "other";
}

export function taskMatchesFilter(task: Task, filter: Filter): boolean {
  switch (filter) {
    case "active":
      return task.status === "downloading" || task.status === "connecting";
    case "completed":
      return task.status === "completed";
    case "media":
      return task.kind === "media";
    case "paused":
      return task.status === "paused" && !task.pendingApproval;
    case "failed":
      return task.status === "failed";
    case "category:video":
      return fileCategory(task) === "video";
    case "category:document":
      return fileCategory(task) === "document";
    case "category:archive":
      return fileCategory(task) === "archive";
    case "category:other":
      return fileCategory(task) === "other";
    default:
      return true;
  }
}

export function sortTasks(tasks: Task[], sort: SortKey, manualOrder?: string[]): Task[] {
  const out = tasks.slice();
  // 手动排序：按持久化的 id 顺序排；不在名单里的（新加的任务）按原顺序补在后面。
  // 只在 mode===manual 时读取，避免每次进度刷新都做多余的 indexOf。
  if (sort === "manual" && manualOrder?.length) {
    const rank = new Map(manualOrder.map((id, index) => [id, index]));
    out.sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
    return out;
  }
  out.sort((a, b) => {
    switch (sort) {
      case "manual":
        return 0;
      case "name":
        return a.filename.localeCompare(b.filename, "zh-CN");
      case "size":
        return b.totalBytes - a.totalBytes;
      case "progress": {
        const pa = a.totalBytes ? a.downloadedBytes / a.totalBytes : 0;
        const pb = b.totalBytes ? b.downloadedBytes / b.totalBytes : 0;
        return pb - pa;
      }
      case "status":
        return statusOrder[a.status] - statusOrder[b.status];
      case "rate":
        return b.speedBps - a.speedBps;
      case "eta": {
        const ea = a.etaSeconds ?? Number.MAX_SAFE_INTEGER;
        const eb = b.etaSeconds ?? Number.MAX_SAFE_INTEGER;
        return ea - eb;
      }
      case "added":
        return b.createdAt - a.createdAt;
      case "domain":
        return a.domain.localeCompare(b.domain, "en");
      default: {
        const activeA = statusOrder[a.status];
        const activeB = statusOrder[b.status];
        if (activeA !== activeB) return activeA - activeB;
        return b.createdAt - a.createdAt;
      }
    }
  });
  return out;
}
