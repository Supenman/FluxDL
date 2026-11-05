import { create } from "zustand";
import type {
  EngineOptions,
  Filter,
  LogLine,
  SortKey,
  Task,
  TaskStatus,
} from "./lib/types";
import { uid } from "./lib/format";

export type Theme = "dark" | "light" | "system";
export type Tone = "info" | "success" | "error";

export interface Toast {
  id: string;
  message: string;
  tone: Tone;
}

export const defaultEngineOptions: EngineOptions = {
  saveDir: "C:\\Users\\Alex\\Downloads",
  maxActive: 3,
  connections: 8,
  globalSpeedLimit: null,
  proxy: null,
  userAgent: "FluxDL/0.1 (Windows)",
  ytDlpPath: "yt-dlp",
  ffmpegPath: null,
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

interface AppStore {
  tasks: Task[];
  selectedId: string | null;
  filter: Filter;
  query: string;
  sort: SortKey;
  settings: EngineOptions;
  settingsLoaded: boolean;
  theme: Theme;
  view: "tasks" | "settings";
  newTaskOpen: boolean;
  newTaskSeed: string;
  commandOpen: boolean;
  clipboardOffer: string | null;
  logs: Record<string, LogLine[]>;
  toasts: Toast[];

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
  setView: (view: "tasks" | "settings") => void;
  setNewTaskOpen: (open: boolean, seed?: string) => void;
  setCommandOpen: (open: boolean) => void;
  setClipboardOffer: (url: string | null) => void;
  pushToast: (message: string, tone?: Tone) => void;
  dismissToast: (id: string) => void;
  appendLog: (line: LogLine) => void;
  clearLogs: (taskId: string) => void;
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
  view: "tasks",
  newTaskOpen: false,
  newTaskSeed: "",
  commandOpen: false,
  clipboardOffer: null,
  logs: {},
  toasts: [],

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
