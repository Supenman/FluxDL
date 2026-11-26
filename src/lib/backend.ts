import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { mockBackend } from "./mock";
import type {
  AddResult,
  ChecksumVerification,
  GrabResult,
  HubListing,
  RemoteZipListing,
  PowerAction,
  UrlProbeInfo,
  AppVersionInfo,
  EngineEvent,
  EngineInfo,
  EngineOptions,
  InstalledTools,
  NewTaskOptions,
  StagedUpdate,
  Task,
  TaskKind,
  ToolProgress,
  ToolVersionItem,
  ToolVersionList,
  AppVersionList,
  UpdateCheck,
  UpdateHistoryItem,
  UpdateProgress,
} from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri =
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

/**
 * 启动结果提示的一次性缓存。
 * Rust 侧 `take_startup_notice` 用 `slot.take()`，取一次即清空：App 启动 toast
 * 和设置页 UpdateSection 都要读，若各自发起 invoke，后挂载的一方必然拿到
 * null（设置页「更新结果」区永远不会渲染）。这里把首次结果缓存成 Promise，
 * 全前端共享，与组件挂载时序无关。
 */
let startupNoticeOnce: Promise<string | null> | null = null;

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

export const backend = {
  isPreview: !isTauri,

  async getTasks(): Promise<{ tasks: Task[]; recoveredFromBackup: boolean }> {
    if (isTauri) return call("get_tasks");
    return { tasks: await mockBackend.getTasks(), recoveredFromBackup: false };
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

  /** 过期链接续期：替换直链并保留已有 .part 进度。 */
  updateTaskUrl(id: string, newUrl: string, autoResume = true): Promise<Task> {
    return isTauri
      ? call<Task>("update_task_url", { id, newUrl, autoResume })
      : mockBackend.updateTaskUrl(id, newUrl, autoResume);
  },

  /** 核对已完成文件的 SHA-256，或为未完成任务登记落盘前自动校验和。 */
  verifyTaskChecksum(id: string, expected: string): Promise<ChecksumVerification> {
    return isTauri
      ? call<ChecksumVerification>("verify_task_checksum", { id, expected })
      : mockBackend.verifyTaskChecksum(id, expected);
  },

  /** 审核通过：批准单条待审核下载并启动。 */
  approve(id: string): Promise<void> {
    return isTauri ? call("approve_task", { id }) : mockBackend.approve(id);
  },

  /** 审核通过：批准当前全部待审核下载。 */
  approveAll(): Promise<void> {
    return isTauri ? call("approve_all_tasks") : mockBackend.approveAll();
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

  /**
   * 是否提供「开机自启」开关。后端用 exe 同级的 uninstall.exe 判断 NSIS 安装版，
   * 便携版与单文件 exe 返回 false，前端据此隐藏或禁用该开关。
   */
  autostartAvailable(): Promise<boolean> {
    return isTauri
      ? call<boolean>("autostart_available")
      : mockBackend.autostartAvailable();
  },

  /** 读取系统里真实的自启状态（Windows 为 HKCU Run 项），重启后仍有效。 */
  autostartEnabled(): Promise<boolean> {
    return isTauri
      ? call<boolean>("autostart_enabled")
      : mockBackend.autostartEnabled();
  },

  /** 打开 / 关闭自启，返回改动后的真实状态；便携版会拒绝。 */
  setAutostart(enabled: boolean): Promise<boolean> {
    return isTauri
      ? call<boolean>("set_autostart", { enabled })
      : mockBackend.setAutostart(enabled);
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

  probeUrl(url: string): Promise<UrlProbeInfo> {
    return isTauri
      ? call<UrlProbeInfo>("probe_url", { url })
      : mockBackend.probeUrl(url);
  },

  grabPageLinks(url: string): Promise<GrabResult> {
    return isTauri
      ? call<GrabResult>("grab_page_links", { url })
      : mockBackend.grabPageLinks(url);
  },

  listRemoteZip(url: string): Promise<RemoteZipListing> {
    return isTauri
      ? call<RemoteZipListing>("list_remote_zip", { url })
      : mockBackend.listRemoteZip(url);
  },

  extractRemoteZipEntries(
    url: string,
    entries: string[],
    saveDir: string,
  ): Promise<string[]> {
    return isTauri
      ? call<string[]>("extract_remote_zip_entries", { url, entries, saveDir })
      : mockBackend.extractRemoteZipEntries(url, entries, saveDir);
  },

  toggleDropTarget(): Promise<boolean> {
    return isTauri ? call<boolean>("toggle_drop_target") : Promise.resolve(false);
  },

  showMainWindow(): Promise<void> {
    return isTauri ? call("show_main_window") : Promise.resolve();
  },

  extractZip(path: string): Promise<string> {
    return isTauri
      ? call<string>("extract_zip", { path })
      : mockBackend.extractZip(path);
  },

  resolveHubUrl(url: string): Promise<HubListing> {
    return isTauri
      ? call<HubListing>("resolve_hub_url", { url })
      : mockBackend.resolveHubUrl(url);
  },

  executePowerAction(action: Exclude<PowerAction, "none">): Promise<void> {
    return isTauri
      ? call("execute_power_action", { action })
      : Promise.resolve();
  },

  setTaskbarProgress(progress: number | null, paused = false): Promise<void> {
    return isTauri
      ? call("set_taskbar_progress", { progress, paused })
      : Promise.resolve();
  },

  openFile(path: string): Promise<void> {
    return isTauri ? call("open_file", { path }) : mockBackend.openFile();
  },

  openExtensionFolder(): Promise<void> {
    return isTauri
      ? call("open_extension_folder")
      : Promise.reject(new Error("浏览器预览模式下不可用"));
  },

  // ---- 版本管理 ----

  appVersionInfo(): Promise<AppVersionInfo> {
    return isTauri
      ? call<AppVersionInfo>("app_version_info")
      : mockBackend.appVersionInfo();
  },

  /** force=true 跳过 6 小时缓存。网络失败不抛异常，错误写在 error 字段。 */
  checkAppUpdate(force = false): Promise<UpdateCheck> {
    return isTauri
      ? call<UpdateCheck>("check_app_update", { force })
      : mockBackend.checkAppUpdate();
  },

  appUpdateHistory(): Promise<UpdateHistoryItem[]> {
    return isTauri
      ? call<UpdateHistoryItem[]>("app_update_history")
      : mockBackend.appUpdateHistory();
  },

  downloadAppUpdate(): Promise<StagedUpdate> {
    return isTauri
      ? call<StagedUpdate>("download_app_update")
      : mockBackend.downloadAppUpdate();
  },

  applyAppUpdateAndRestart(): Promise<string> {
    return isTauri
      ? call<string>("apply_app_update_and_restart")
      : mockBackend.applyAppUpdateAndRestart();
  },

  /**
   * 启动时的更新结果提示（已应用 / 已回滚）。
   * 底层命令取一次即清空，因此这里只真正调用一次并缓存结果；App 的启动
   * toast 与设置页 UpdateSection 复用同一个 Promise，避免后者拿到 null。
   */
  takeStartupNotice(): Promise<string | null> {
    if (!startupNoticeOnce) {
      startupNoticeOnce = isTauri
        ? call<string | null>("take_startup_notice").catch(() => null)
        : Promise.resolve(null);
    }
    return startupNoticeOnce;
  },

  async onUpdateProgress(
    callback: (progress: UpdateProgress) => void,
  ): Promise<() => void> {
    if (!isTauri) return () => {};
    return listen<UpdateProgress>("update:progress", (event) =>
      callback(event.payload),
    );
  },

  appVersionList(): Promise<AppVersionList> {
    return isTauri
      ? call<AppVersionList>("app_version_list")
      : mockBackend.appVersionList();
  },

  activateAppVersion(version: string): Promise<string> {
    return isTauri
      ? call<string>("activate_app_version", { version })
      : mockBackend.activateAppVersion(version);
  },

  deleteAppVersion(version: string): Promise<string> {
    return isTauri
      ? call<string>("delete_app_version", { version })
      : mockBackend.deleteAppVersion(version);
  },

  toolVersionList(tool: string): Promise<ToolVersionList> {
    return isTauri
      ? call<ToolVersionList>("tool_version_list", { tool })
      : mockBackend.toolVersionList(tool);
  },

  toolInstallVersion(tool: string, version: string): Promise<ToolVersionItem> {
    return isTauri
      ? call<ToolVersionItem>("tool_install_version", { tool, version })
      : mockBackend.toolInstallVersion(tool, version);
  },

  toolActivateVersion(tool: string, version: string): Promise<ToolVersionItem> {
    return isTauri
      ? call<ToolVersionItem>("tool_activate_version", { tool, version })
      : mockBackend.toolActivateVersion(tool, version);
  },

  toolRollback(tool: string): Promise<ToolVersionItem> {
    return isTauri
      ? call<ToolVersionItem>("tool_rollback", { tool })
      : mockBackend.toolRollback(tool);
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
