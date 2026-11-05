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
  clipboardWatch: boolean;
  closeToTray: boolean;
  openFolderAfter: boolean;
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
