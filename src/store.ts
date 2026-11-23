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
} from "./lib/types";
import { uid } from "./lib/format";
import { readAccent, saveAccent, type AccentColors } from "./lib/theme";

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

interface AppStore {
  tasks: Task[];
  selectedId: string | null;
  filter: Filter;
  query: string;
  sort: SortKey;
  settings: EngineOptions;
  settingsLoaded: boolean;
  theme: Theme;
  /** 紧凑多列视图：在任务行显示添加时间/来源/平均速度等额外列 */
  compact: boolean;
  /** 自定义强调色（预设或导入），null 表示用默认经典蓝 */
  accent: AccentColors | null;
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
  setFilter: (filter: Filter) => void;
  setQuery: (query: string) => void;
  setSort: (sort: SortKey) => void;
  setSettings: (patch: Partial<EngineOptions>) => void;
  setSettingsLoaded: (loaded: boolean) => void;
  setTheme: (theme: Theme) => void;
  setCompact: (compact: boolean) => void;
  setAccent: (accent: AccentColors | null) => void;
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
  filter: "all",
  query: "",
  sort: "recent",
  settings: defaultEngineOptions,
  settingsLoaded: false,
  theme: readTheme(),
  compact: readCompact(),
  accent: readAccent(),
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
      progressId: state.progressId === id ? null : state.progressId,
    })),

  select: (id) => set({ selectedId: id }),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  setSort: (sort) => set({ sort }),

  setSettings: (patch) =>
    set((state) => ({ settings: { ...state.settings, ...patch } })),
  setSettingsLoaded: (loaded) => set({ settingsLoaded: loaded }),

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

  setAccent: (accent) => {
    saveAccent(accent);
    set({ accent });
  },

  setProgressId: (progressId) => set({ progressId }),

  setView: (view) => set({ view, selectedId: null }),

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
      return task.status === "paused";
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

export function sortTasks(tasks: Task[], sort: SortKey): Task[] {
  const out = tasks.slice();
  out.sort((a, b) => {
    switch (sort) {
      case "name":
        return a.filename.localeCompare(b.filename, "zh-CN");
      case "size":
        return b.totalBytes - a.totalBytes;
      case "progress": {
        const pa = a.totalBytes ? a.downloadedBytes / a.totalBytes : 0;
        const pb = b.totalBytes ? b.downloadedBytes / b.totalBytes : 0;
        return pb - pa;
      }
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
