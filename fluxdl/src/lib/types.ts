export type TaskStatus =
  | "queued"
  | "connecting"
  | "downloading"
  | "paused"
  | "completed"
  | "failed";

export type TaskKind = "http" | "media";

export interface Segment {
  index: number;
  start: number;
  end: number;
  downloaded: number;
  done: boolean;
}

export interface Task {
  id: string;
  kind: TaskKind;
  url: string;
  filename: string;
  savePath: string;
  totalBytes: number;
  downloadedBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  status: TaskStatus;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  connections: number;
  resumable: boolean;
  segments: Segment[];
  speedLimit: number | null;
  referer: string | null;
  userAgent: string | null;
  proxy: string | null;
  format: string | null;
  mime: string | null;
  domain: string;
}

export interface NewTaskOptions {
  saveDir?: string;
  filename?: string;
  connections?: number;
  speedLimit?: number | null;
  referer?: string | null;
  userAgent?: string | null;
  proxy?: string | null;
  headers?: Record<string, string>;
  format?: string | null;
}

export interface EngineOptions {
  saveDir: string;
  maxActive: number;
  connections: number;
  globalSpeedLimit: number | null;
  proxy: string | null;
  userAgent: string;
  ytDlpPath: string;
  ffmpegPath: string | null;
  /** 自动更新随包内置的 yt-dlp（YouTube 频繁改版，旧版必崩）。默认开启。 */
  autoUpdateYtDlp?: boolean;
  clipboardWatch: boolean;
  closeToTray: boolean;
  openFolderAfter: boolean;
}

export interface InstalledTools {
  ytDlpPath: string;
  ffmpegPath: string | null;
  ytDlpAvailable: boolean;
  ffmpegAvailable: boolean;
}

export interface ToolProgress {
  tool: string;
  phase: string;
  downloaded: number;
  total: number;
}

export interface EngineInfo {
  version: string;
  os: string;
  ytDlpPath: string;
  ytDlpAvailable: boolean;
  ffmpegAvailable: boolean;
}

export interface AddResult {
  tasks: Task[];
  errors: string[];
}

export interface LogLine {
  taskId: string;
  message: string;
  at: number;
}

export type EngineEvent =
  | { type: "task"; payload: Task }
  | { type: "removed"; payload: string }
  | { type: "log"; payload: LogLine }
  | { type: "clipboardUrl"; payload: string };

export type Filter = "all" | "active" | "completed" | "media" | "paused" | "failed";
export type SortKey = "recent" | "name" | "size" | "progress";

// ---------------------------------------------------------------------------
// 版本管理
// ---------------------------------------------------------------------------

export interface AppVersionInfo {
  appVersion: string;
  engineVersion: string;
  platform: string;
  installDir: string;
  /** 便携版：exe 同目录就有 tools/ 与 browser-extension/。 */
  portable: boolean;
}

export interface UpdateHistoryItem {
  version: string;
  releasedAt: string;
  channel: string | null;
  notes: string[];
}

export interface UpdateCheck {
  current: string;
  latest: string;
  available: boolean;
  /** 当前版本低于清单里的最低支持版本，必须更新。 */
  forced: boolean;
  releasedAt: string;
  notes: string[];
  size: number | null;
  platform: string;
  source: string;
  checkedAt: number;
  history: UpdateHistoryItem[];
  /** 检查失败的原因；此时 available 为 false，但 history 可能来自缓存。 */
  error: string | null;
}

export interface UpdateProgress {
  phase: "download" | "verify" | string;
  downloaded: number;
  total: number;
}

export interface StagedUpdate {
  version: string;
  size: number;
  stagedPath: string;
  needsRestart: boolean;
}

export interface ToolVersionItem {
  version: string;
  path: string | null;
  size: number | null;
  installed: boolean;
  active: boolean;
  releasedAt: string | null;
  notes: string | null;
}

export interface ToolVersionList {
  tool: string;
  active: string | null;
  previous: string | null;
  latest: string | null;
  updateAvailable: boolean;
  installed: ToolVersionItem[];
  available: ToolVersionItem[];
  /** 远端不可达时的提示，界面据此降级为「仅本地版本」。 */
  warning: string | null;
}
