import type {
  AddResult,
  EngineEvent,
  EngineInfo,
  EngineOptions,
  NewTaskOptions,
  Segment,
  Task,
  TaskKind,
} from "./types";
import { uid } from "./format";

const MB = 1024 * 1024;
const GB = 1024 * MB;

function segments(total: number, downloaded: number, count: number): Segment[] {
  if (!total) return [];
  const chunk = Math.floor(total / count);
  const out: Segment[] = [];
  let left = downloaded;
  for (let i = 0; i < count; i++) {
    const start = i * chunk;
    const end = i === count - 1 ? total - 1 : start + chunk - 1;
    const length = end - start + 1;
    const take = Math.min(length, Math.max(0, left));
    left -= take;
    out.push({
      index: i,
      start,
      end,
      downloaded: take,
      done: take >= length,
    });
  }
  return out;
}

function seedTasks(): Task[] {
  const now = Date.now();
  const home = "C:\\Users\\Alex\\Downloads";
  const mk = (
    id: string,
    kind: TaskKind,
    filename: string,
    url: string,
    total: number,
    downloaded: number,
    status: Task["status"],
    speed: number,
    createdAgo: number,
    extra: Partial<Task> = {},
  ): Task => {
    const conns = kind === "media" ? 1 : 8;
    return {
      id,
      kind,
      url,
      filename,
      savePath: `${home}\\${filename}`,
      totalBytes: total,
      downloadedBytes: downloaded,
      speedBps: speed,
      etaSeconds: speed > 0 ? Math.round((total - downloaded) / speed) : null,
      status,
      error: null,
      createdAt: now - createdAgo,
      finishedAt: status === "completed" ? now - createdAgo + 120000 : null,
      connections: conns,
      resumable: kind === "http",
      segments: segments(total, downloaded, conns),
      speedLimit: null,
      referer: null,
      userAgent: "FluxDL/0.1 (Windows)",
      proxy: null,
      format: kind === "media" ? "mp4" : null,
      mime: kind === "media" ? "video/mp4" : "application/octet-stream",
      domain: new URL(url).hostname.replace(/^www\./, ""),
      ...extra,
    };
  };

  return [
    mk(
      "seed-1",
      "http",
      "Adobe Photoshop 2024 v25.3.1.iso",
      "https://download.adobe.example/photoshop-2024.iso",
      4.6 * GB,
      2.91 * GB,
      "downloading",
      3.4 * MB,
      14 * 60000,
    ),
    mk(
      "seed-2",
      "media",
      "城市夜景 4K 延时摄影.mp4",
      "https://www.youtube.com/watch?v=city-night",
      1.92 * GB,
      1.92 * GB,
      "completed",
      0,
      3 * 3600000,
      { finishedAt: now - 2 * 3600000 },
    ),
    mk(
      "seed-3",
      "http",
      "ubuntu-24.04-desktop-amd64.iso",
      "https://mirrors.aliyun.example/ubuntu-24.04-desktop-amd64.iso",
      3.68 * GB,
      1.14 * GB,
      "downloading",
      1.9 * MB,
      8 * 60000,
    ),
    mk(
      "seed-4",
      "media",
      "Blender 4.2 官方教程合集.mp4",
      "https://www.bilibili.com/video/BV1Blender42",
      684 * MB,
      684 * MB,
      "completed",
      0,
      26 * 3600000,
      { finishedAt: now - 25 * 3600000 },
    ),
    mk(
      "seed-5",
      "http",
      "ML-2025-春-数据集.zip",
      "https://dataset.example/ML-2025-spring.zip",
      826 * MB,
      388 * MB,
      "paused",
      0,
      42 * 60000,
      { speedLimit: 2 * MB },
    ),
    mk(
      "seed-6",
      "http",
      "Windows 11 24H2 x64.iso",
      "https://software.example/win11-24h2.iso",
      5.82 * GB,
      5.82 * GB,
      "completed",
      0,
      2 * 86400000,
    ),
    mk(
      "seed-7",
      "http",
      "开源字体合集（思源 + 霞鹜）.zip",
      "https://fonts.example/open-source-fonts.zip",
      312 * MB,
      84 * MB,
      "failed",
      0,
      5 * 3600000,
      { error: "服务器返回 HTTP 403，链接可能已失效或需要登录" },
    ),
    mk(
      "seed-8",
      "http",
      "Figma 桌面版 Setup.exe",
      "https://download.figma.example/FigmaSetup.exe",
      96 * MB,
      0,
      "queued",
      0,
      30000,
    ),
  ];
}

function filenameFromUrl(url: string, kind: TaskKind): string {
  try {
    const path = new URL(url).pathname;
    const name = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
    if (name && name.includes(".")) return name;
  } catch {
    // ignore
  }
  return kind === "media" ? "video.mp4" : "download.bin";
}

export class MockBackend {
  private tasks: Task[] = seedTasks();
  private listeners = new Set<(event: EngineEvent) => void>();
  private options: EngineOptions = {
    saveDir: "C:\\Users\\Alex\\Downloads",
    maxActive: 3,
    connections: 8,
    globalSpeedLimit: null,
    proxy: null,
    userAgent: "FluxDL/0.1 (Windows)",
    ytDlpPath: "yt-dlp",
    ffmpegPath: "ffmpeg",
    clipboardWatch: true,
    closeToTray: true,
    openFolderAfter: false,
  };
  private timer: number | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.timer = window.setInterval(() => this.tick(), 420);
    }
  }

  private emit(event: EngineEvent) {
    this.listeners.forEach((fn) => fn(event));
  }

  private tick() {
    const now = Date.now();
    for (const task of this.tasks) {
      if (task.status === "downloading") {
        const jitter = 0.82 + Math.random() * 0.36;
        const speed = Math.round(
          (task.speedBps || 2 * MB) * (0.94 + Math.random() * 0.12),
        );
        const gain = Math.floor(speed * 0.42 * jitter);
        task.downloadedBytes = Math.min(task.totalBytes, task.downloadedBytes + gain);
        task.speedBps = speed;
        task.etaSeconds =
          speed > 0 ? Math.round((task.totalBytes - task.downloadedBytes) / speed) : null;
        task.segments = segments(task.totalBytes, task.downloadedBytes, task.connections);
        if (task.downloadedBytes >= task.totalBytes) {
          task.status = "completed";
          task.speedBps = 0;
          task.etaSeconds = null;
          task.finishedAt = now;
          task.segments = segments(task.totalBytes, task.totalBytes, task.connections);
        }
        this.emit({ type: "task", payload: { ...task } });
      } else if (task.status === "queued" && now - task.createdAt > 1500) {
        task.status = "connecting";
        this.emit({ type: "task", payload: { ...task } });
        window.setTimeout(() => {
          if (task.status !== "connecting") return;
          task.status = "downloading";
          task.totalBytes = task.totalBytes || Math.round((80 + Math.random() * 420) * MB);
          task.speedBps = Math.round((1.4 + Math.random() * 2.6) * MB);
          task.connections = 8;
          task.segments = segments(task.totalBytes, 0, 8);
          this.emit({ type: "task", payload: { ...task } });
        }, 900);
      }
    }
  }

  onEvent(cb: (event: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async getTasks(): Promise<Task[]> {
    return this.tasks.map((t) => ({ ...t, segments: [...t.segments] }));
  }

  async addTasks(urls: string[], kind: TaskKind, opts: NewTaskOptions): Promise<AddResult> {
    const tasks: Task[] = [];
    const errors: string[] = [];
    for (const raw of urls) {
      const url = raw.trim();
      if (!url) continue;
      if (!/^https?:\/\//i.test(url)) {
        errors.push(`${url}：仅支持 http / https 链接`);
        continue;
      }
      const filename = filenameFromUrl(url, kind);
      const total = kind === "media" ? Math.round((400 + Math.random() * 900) * MB) : Math.round((60 + Math.random() * 300) * MB);
      const task: Task = {
        id: uid(),
        kind,
        url,
        filename: opts.filename || filename,
        savePath: `${opts.saveDir || this.options.saveDir}\\${opts.filename || filename}`,
        totalBytes: 0,
        downloadedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        status: "queued",
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
        connections: opts.connections ?? this.options.connections,
        resumable: false,
        segments: [],
        speedLimit: opts.speedLimit ?? null,
        referer: opts.referer ?? null,
        userAgent: opts.userAgent ?? this.options.userAgent,
        proxy: opts.proxy ?? this.options.proxy,
        format: kind === "media" ? opts.format ?? "mp4" : null,
        mime: kind === "media" ? "video/mp4" : null,
        domain: new URL(url).hostname.replace(/^www\./, ""),
      };
      this.tasks.unshift(task);
      tasks.push(task);
      this.emit({ type: "task", payload: { ...task } });
      window.setTimeout(() => {
        task.status = "connecting";
        task.totalBytes = total;
        task.segments = segments(total, 0, task.connections);
        this.emit({ type: "task", payload: { ...task } });
      }, 350);
      window.setTimeout(() => {
        if (task.status === "paused") return;
        task.status = "downloading";
        task.speedBps = Math.round((1.5 + Math.random() * 2.5) * MB);
        this.emit({ type: "task", payload: { ...task } });
      }, 1000);
    }
    return { tasks, errors };
  }

  async pause(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || !["queued", "connecting", "downloading"].includes(task.status)) return;
    task.status = "paused";
    task.speedBps = 0;
    task.etaSeconds = null;
    this.emit({ type: "task", payload: { ...task } });
  }

  async resume(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || ["downloading", "connecting", "completed"].includes(task.status)) return;
    task.status = "downloading";
    task.error = null;
    task.speedBps = Math.round((1.5 + Math.random() * 2.5) * MB);
    this.emit({ type: "task", payload: { ...task } });
  }

  async retry(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.error = null;
    task.status = "downloading";
    task.speedBps = Math.round((1.5 + Math.random() * 2.5) * MB);
    this.emit({ type: "task", payload: { ...task } });
  }

  async remove(id: string) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.emit({ type: "removed", payload: id });
  }

  async pauseAll() {
    for (const task of this.tasks) {
      if (["queued", "connecting", "downloading"].includes(task.status)) {
        task.status = "paused";
        task.speedBps = 0;
        task.etaSeconds = null;
        this.emit({ type: "task", payload: { ...task } });
      }
    }
  }

  async resumeAll() {
    for (const task of this.tasks) {
      if (task.status === "paused" || task.status === "failed") {
        task.status = "downloading";
        task.error = null;
        task.speedBps = Math.round((1.5 + Math.random() * 2.5) * MB);
        this.emit({ type: "task", payload: { ...task } });
      }
    }
  }

  async setTaskSpeedLimit(id: string, limit: number | null) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.speedLimit = limit;
    this.emit({ type: "task", payload: { ...task } });
  }

  async getEngineOptions(): Promise<EngineOptions> {
    return { ...this.options };
  }

  async setEngineOptions(options: EngineOptions): Promise<EngineOptions> {
    this.options = { ...options };
    return { ...this.options };
  }

  async setClipboardWatch(enabled: boolean) {
    this.options.clipboardWatch = enabled;
  }

  async engineInfo(): Promise<EngineInfo> {
    return {
      version: "0.1.0-preview",
      os: "windows",
      ytDlpPath: this.options.ytDlpPath,
      ytDlpAvailable: true,
      ffmpegAvailable: true,
    };
  }

  async pickFolder(): Promise<string | null> {
    return null;
  }

  async pickFile(): Promise<string | null> {
    return null;
  }

  async openPath(): Promise<void> {
    // no-op in preview
  }

  async openFile(): Promise<void> {
    // no-op in preview
  }

  dispose() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.listeners.clear();
  }
}

export const mockBackend = new MockBackend();
