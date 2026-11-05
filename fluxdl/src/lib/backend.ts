import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { mockBackend } from "./mock";
import type {
  AddResult,
  EngineEvent,
  EngineInfo,
  EngineOptions,
  InstalledTools,
  NewTaskOptions,
  Task,
  TaskKind,
  ToolProgress,
} from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri =
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

export const backend = {
  isPreview: !isTauri,

  getTasks(): Promise<Task[]> {
    return isTauri ? call<Task[]>("get_tasks") : mockBackend.getTasks();
  },

  addTasks(
    urls: string[],
    kind: TaskKind,
    options: NewTaskOptions,
  ): Promise<AddResult> {
    return isTauri
      ? call<AddResult>("add_tasks", { urls, kind, options })
      : mockBackend.addTasks(urls, kind, options);
  },

  pause(id: string): Promise<void> {
    return isTauri ? call("pause_task", { id }) : mockBackend.pause(id);
  },

  resume(id: string): Promise<void> {
    return isTauri ? call("resume_task", { id }) : mockBackend.resume(id);
  },

  retry(id: string): Promise<void> {
    return isTauri ? call("retry_task", { id }) : mockBackend.retry(id);
  },

  remove(id: string, deleteFile: boolean): Promise<void> {
    return isTauri
      ? call("remove_task", { id, deleteFile })
      : mockBackend.remove(id);
  },

  pauseAll(): Promise<void> {
    return isTauri ? call("pause_all") : mockBackend.pauseAll();
  },

  resumeAll(): Promise<void> {
    return isTauri ? call("resume_all") : mockBackend.resumeAll();
  },

  setTaskSpeedLimit(id: string, limit: number | null): Promise<void> {
    return isTauri
      ? call("set_task_speed_limit", { id, limit })
      : mockBackend.setTaskSpeedLimit(id, limit);
  },

  getEngineOptions(): Promise<EngineOptions> {
    return isTauri
      ? call<EngineOptions>("get_engine_options")
      : mockBackend.getEngineOptions();
  },

  setEngineOptions(options: EngineOptions): Promise<EngineOptions> {
    return isTauri
      ? call<EngineOptions>("set_engine_options", { options })
      : mockBackend.setEngineOptions(options);
  },

  setClipboardWatch(enabled: boolean): Promise<void> {
    return isTauri
      ? call("set_clipboard_watch", { enabled })
      : mockBackend.setClipboardWatch(enabled);
  },

  engineInfo(): Promise<EngineInfo> {
    return isTauri ? call<EngineInfo>("engine_info") : mockBackend.engineInfo();
  },

  installTools(): Promise<InstalledTools> {
    return isTauri
      ? call<InstalledTools>("install_tools")
      : mockBackend.installTools();
  },

  async onToolProgress(
    callback: (progress: ToolProgress) => void,
  ): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen<ToolProgress>("tools:progress", (event) =>
      callback(event.payload),
    );
  },

  async pickFolder(defaultPath?: string): Promise<string | null> {
    if (!isTauri) return mockBackend.pickFolder();
    return call<string | null>("pick_folder", { defaultPath: defaultPath ?? null });
  },

  async pickFile(defaultPath?: string): Promise<string | null> {
    if (!isTauri) return mockBackend.pickFile();
    return call<string | null>("pick_file", { defaultPath: defaultPath ?? null });
  },

  openPath(path: string): Promise<void> {
    return isTauri ? call("open_path", { path }) : mockBackend.openPath();
  },

  openFile(path: string): Promise<void> {
    return isTauri ? call("open_file", { path }) : mockBackend.openFile();
  },

  openExtensionFolder(): Promise<void> {
    return isTauri
      ? call("open_extension_folder")
      : Promise.reject(new Error("浏览器预览模式下不可用"));
  },

  /** Subscribes to engine + clipboard events. Returns an unsubscribe fn. */
  async onEvent(callback: (event: EngineEvent) => void): Promise<() => void> {
    if (!isTauri) {
      return mockBackend.onEvent(callback);
    }
    const unlistenEngine = await listen<EngineEvent>("engine:event", (event) =>
      callback(event.payload),
    );
    const unlistenClipboard = await listen<string>("clipboard:url", (event) =>
      callback({ type: "clipboardUrl", payload: event.payload }),
    );
    return () => {
      unlistenEngine();
      unlistenClipboard();
    };
  },
};

export const windowControls = {
  async minimize() {
    if (isTauri) await getCurrentWindow().minimize();
  },
  async toggleMaximize() {
    if (isTauri) await getCurrentWindow().toggleMaximize();
  },
  async close() {
    if (isTauri) await getCurrentWindow().close();
  },
};
