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
  /**
   * aria2c 路径：视频任务用它做多连接分段下载（-x16 -s16），绕开站点单连接限速。
   * 留空表示按「yt-dlp 同目录 → 随包 tools/ → exe 同级」自动探测；
   * 探测不到会自动退回 yt-dlp 原生下载器，功能不中断。
   */
  aria2Path?: string | null;
  /** 自动更新随包内置的 yt-dlp（YouTube 频繁改版，旧版必崩）。默认开启。 */
  autoUpdateYtDlp?: boolean;
  /**
   * 视频站点解析用的浏览器 Cookie 来源（B 档）。抖音等站点网页解析需要浏览器
   * cookie / 登录态，由 yt-dlp 直接读本机浏览器，扩展与网页探针不接触凭证。
   * "none" / null = 不读取；"chrome" / "edge" / "firefox" / "brave" 等浏览器名。
   */
  mediaCookieBrowser?: string | null;
  /** 自定义 Netscape cookies.txt 路径，优先级高于 mediaCookieBrowser。 */
  mediaCookieFile?: string | null;
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

/** 一个已安装的主程序版本（app-versions 目录里的一个 exe）。 */
export interface AppVersionItem {
  version: string;
  active: boolean;
  previous: boolean;
  size: number;
}

/** 主程序版本清单：多版本共存、随时切换、一键回滚。 */
export interface AppVersionList {
  active: string;
  previous: string | null;
  installed: AppVersionItem[];
  versionsDir: string;
  /** 是否由启动器托管；false 时无法切换版本，界面需解释原因。 */
  managed: boolean;
  keep: number;
  warning: string | null;
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
