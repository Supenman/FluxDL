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

/**
 * 媒体站点名单 —— 必须与 src-tauri/src/lib.rs 的 looks_like_media HOSTS 逐项一致。
 * 浏览器扩展自动接管时由 Rust 侧判定，桌面新建时由这里判定；两份名单分裂会让
 * 同一个链接在两条入口被建成不同的任务类型（0.3.3 的实际缺陷）。
 */
const MEDIA_HOSTS = [
  // 国内
  "bilibili.com",
  "b23.tv",
  "douyin.com",
  "iesdouyin.com",
  "kuaishou.com",
  "xiaohongshu.com",
  "xhslink.com",
  "weibo.com",
  "iqiyi.com",
  "youku.com",
  "mgtv.com",
  "v.qq.com",
  "music.163.com",
  "zhihu.com",
  "ixigua.com",
  "acfun.cn",
  // 国外
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "facebook.com",
  "twitch.tv",
  "dailymotion.com",
  "nicovideo.jp",
] as const;

/** 完整容器直链（CDN 视频 / 音频整文件）—— 按 HTTP 直链下载，不交给 yt-dlp。
 *  规则须与 Rust 的 is_direct_media_file、扩展的 isDirectMediaFile 保持一致；
 *  分片清单 .m3u8 / .mpd / .m4s 不在其中，仍需 yt-dlp 合并。
 */
const DIRECT_MEDIA_EXT = /\.(mp4|m4v|mkv|webm|mov|flv|avi|ts|mp3|m4a|aac|flac|wav|ogg|opus)(?:[?#]|$)/i;

export function isDirectMediaFile(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  return DIRECT_MEDIA_EXT.test(path);
}

/** 按主机名精确 / 后缀匹配；includes 会把 apex.com、路径里的 x.com 都误判成媒体。 */
export function isMediaUrl(url: string): boolean {
  // CDN 直链常带站点后缀（如 v2.kuaishou.com/abc.mp4），命中站点名单会被
  // 错建成媒体任务交给 yt-dlp 报 Unsupported URL；必须先短路成普通下载。
  if (isDirectMediaFile(url)) return false;
  let host: string | null = null;
  // 用户可能粘贴不带 scheme 的地址（或纯 BV 号补全后的地址）
  for (const candidate of [url, `https://${url}`]) {
    try {
      host = new URL(candidate).hostname.toLowerCase();
      break;
    } catch {
      // 试下一个
    }
  }
  if (!host) return false;
  return MEDIA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const cleaned = matches.map((u) => u.replace(/[),.;]+$/, ""));
  const fromHttp = Array.from(new Set(cleaned));
  // 兼容 B 站「复制 BV 号」场景：纯 `BV1xxxx`（不带 https://）也能被识别。
  // 仅当文本里没有已含该 BV 号的完整链接时才补全，避免与上面的 http 链接重复。
  const bvMatches = Array.from(
    new Set(text.match(/(?:^|[^A-Za-z0-9])BV1[0-9A-Za-z]{9}(?![A-Za-z0-9])/gi) ?? []),
  ).map((m) => m.replace(/^[^B]+/, ""));
  const fromBv = bvMatches
    .filter((bv) => !fromHttp.some((u) => u.includes(bv)))
    .map((bv) => `https://www.bilibili.com/video/${bv}`);
  return Array.from(new Set([...fromHttp, ...fromBv]));
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
