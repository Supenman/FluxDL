import type { Task } from "./types";

export function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatBytes(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  const digits = value >= 100 || i === 0 ? 0 : precision;
  return `${value.toFixed(digits)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function percent(task: { totalBytes: number; downloadedBytes: number }): number {
  if (!task.totalBytes) return 0;
  return Math.min(100, Math.max(0, (task.downloadedBytes / task.totalBytes) * 100));
}

export function formatDate(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `今天 ${time}`;
  return `${date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${time}`;
}

export interface FileStyle {
  label: string;
  tone: "video" | "archive" | "disk" | "doc" | "app" | "other";
}

export function fileStyle(task: Task): FileStyle {
  if (task.kind === "media") return { label: "VIDEO", tone: "video" };
  const ext = task.filename.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "mkv", "mov", "avi", "webm", "flv", "ts", "m4v"].includes(ext))
    return { label: ext.toUpperCase().slice(0, 5), tone: "video" };
  if (["zip", "rar", "7z", "tar", "gz", "xz", "bz2"].includes(ext))
    return { label: ext.toUpperCase().slice(0, 5), tone: "archive" };
  if (["iso", "img", "dmg", "vhd", "vhdx"].includes(ext))
    return { label: ext.toUpperCase().slice(0, 5), tone: "disk" };
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "epub"].includes(ext))
    return { label: ext.toUpperCase().slice(0, 5), tone: "doc" };
  if (["exe", "msi", "msix", "apk", "dmg", "pkg"].includes(ext))
    return { label: ext.toUpperCase().slice(0, 5), tone: "app" };
  return { label: ext ? ext.toUpperCase().slice(0, 5) : "FILE", tone: "other" };
}

export function hostOf(url: string, fallback = "本地文件"): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || fallback;
  } catch {
    return fallback;
  }
}

export function shortPath(path: string, max = 52): string {
  if (path.length <= max) return path;
  const parts = path.split(/[\\/]/);
  const tail = parts.slice(-2).join("\\");
  return `…\\${tail}`;
}

export function isMediaUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return [
    "youtube.com",
    "youtu.be",
    "bilibili.com",
    "b23.tv",
    "vimeo.com",
    "douyin.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "x.com/",
    "instagram.com",
    "facebook.com",
    "twitch.tv",
    "dailymotion.com",
    "nicovideo.jp",
    "weibo.com",
    "xiaohongshu.com",
  ].some((domain) => lower.includes(domain));
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const cleaned = matches.map((u) => u.replace(/[),.;]+$/, ""));
  return Array.from(new Set(cleaned));
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
