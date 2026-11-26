import type {
  AddResult,
  ChecksumVerification,
  GrabResult,
  HubListing,
  UrlProbeInfo,
  AppVersionInfo,
  EngineEvent,
  EngineInfo,
  EngineOptions,
  InstalledTools,
  NewTaskOptions,
  Segment,
  StagedUpdate,
  Task,
  TaskKind,
  ToolVersionItem,
  AppVersionList,
  ToolVersionList,
  UpdateCheck,
  UpdateHistoryItem,
} from "./types";
import { uid } from "./format";

const MB = 1024 * 1024;
const GB = 1024 * MB;

function segments(total: number, downloaded: number, count: number): Segment[] {
  if (!total) return [];
  // count=0 是自动档，mock 里按体积给个合理段数，避免 total/0 得 Infinity。
  if (count <= 0) {
    const mib = 1024 * 1024;
    count = total < 4 * mib ? 2 : total < 32 * mib ? 4 : total < 256 * mib ? 8 : 16;
  }
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
      scheduledAt: null,
      pendingApproval: false,
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
  /** 预览模式下自启开关不可用，这里存一个状态仅为接口行为完整。 */
  private autostartEnabledState = false;
  private options: EngineOptions = {
    saveDir: "C:\\Users\\Alex\\Downloads",
    organizeByCategory: false,
    maxActive: 3,
    connections: 0, // 与真实后端 / store 一致：默认自动档
    globalSpeedLimit: null,
    proxy: null,
    userAgent: "FluxDL/0.1 (Windows)",
    ytDlpPath: "yt-dlp",
    ffmpegPath: "ffmpeg",
    autoUpdateYtDlp: true,
    clipboardWatch: true,
    closeToTray: true,
    openFolderAfter: false,
    approveCapturedDownloads: false,
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
      // B2：定时到点，清空计划时间并转入正常启动流程。
      if (
        task.status === "paused" &&
        task.scheduledAt != null &&
        task.scheduledAt > 0 &&
        task.scheduledAt <= now
      ) {
        task.scheduledAt = null;
        task.status = "queued";
        task.createdAt = now;
        this.emit({ type: "task", payload: { ...task } });
        continue;
      }
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
        scheduledAt: opts.scheduledAt ?? null,
        pendingApproval: true,
      };
      this.tasks.unshift(task);
      tasks.push(task);
      this.emit({ type: "task", payload: { ...task } });
      window.setTimeout(() => {
        if (task.pendingApproval) return;
        task.status = "connecting";
        task.totalBytes = total;
        task.segments = segments(total, 0, task.connections);
        this.emit({ type: "task", payload: { ...task } });
      }, 350);
      window.setTimeout(() => {
        if (task.pendingApproval || task.status === "paused") return;
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
    if (!task || task.pendingApproval || ["downloading", "connecting", "completed"].includes(task.status)) return;
    task.status = "downloading";
    task.error = null;
    task.speedBps = Math.round((1.5 + Math.random() * 2.5) * MB);
    this.emit({ type: "task", payload: { ...task } });
  }

  async approve(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || !task.pendingApproval) return;
    task.pendingApproval = false;
    task.scheduledAt = null;
    task.status = "connecting";
    task.totalBytes = Math.round((60 + Math.random() * 300) * MB);
    task.segments = segments(task.totalBytes, 0, task.connections);
    this.emit({ type: "task", payload: { ...task } });
    window.setTimeout(() => {
      if (task.status !== "connecting") return;
      task.status = "downloading";
      task.speedBps = Math.round((1.5 + Math.random() * 2.5) * MB);
      this.emit({ type: "task", payload: { ...task } });
    }, 800);
  }

  async approveAll() {
    for (const task of this.tasks) {
      if (task.pendingApproval) await this.approve(task.id);
    }
  }

  async retry(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.pendingApproval) return;
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
      if (!task.pendingApproval && (task.status === "paused" || task.status === "failed")) {
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

  async autostartAvailable(): Promise<boolean> {
    // 浏览器预览不是 NSIS 安装版，与真实便携版一样不提供自启开关。
    return false;
  }

  async autostartEnabled(): Promise<boolean> {
    return this.autostartEnabledState;
  }

  async setAutostart(enabled: boolean): Promise<boolean> {
    this.autostartEnabledState = enabled;
    return this.autostartEnabledState;
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

  async installTools(): Promise<InstalledTools> {
    return {
      ytDlpPath: this.options.ytDlpPath,
      ffmpegPath: this.options.ffmpegPath,
      ytDlpAvailable: true,
      ffmpegAvailable: true,
    };
  }

  // ---- 版本管理（浏览器预览用的假数据，仅验证界面，不触网） ----

  async appVersionInfo(): Promise<AppVersionInfo> {
    return {
      appVersion: "0.3.0",
      engineVersion: "0.3.0-preview",
      platform: "windows-x64",
      installDir: "C:\\Program Files\\FluxDL",
      portable: false,
    };
  }

  async checkAppUpdate(): Promise<UpdateCheck> {
    const history: UpdateHistoryItem[] = [
      {
        version: "0.3.0",
        releasedAt: "2026-11-06T09:00:00Z",
        channel: "stable",
        notes: [
          "新增主程序版本管理：更新后无需重装安装包，旧版本自动留在版本库，随时一键回退",
          "更新改为「下载进版本库 → 点更新 → 自动重启」，全程 2~3 秒；连续两次启动失败会自动回退",
          "视频下载改为一次直下：失败立即报错，不再出现「下载中 0B/未知」长时间空转",
          "视频分片并发 4 路，B 站切换 tv/app 客户端，单连接限速问题显著缓解",
          "不再读取、传输或落盘任何 cookie，登录凭证不会离开浏览器",
          "媒体任务只保留国内站点（B 站、抖音、快手、小红书等），国外站点请用直链普通下载",
        ],
      },
      {
        version: "0.2.0",
        releasedAt: "2026-11-06T02:00:00Z",
        channel: "stable",
        notes: [
          "设置页新增版本管理：查看版本号、更新历史与一键更新",
          "yt-dlp / ffmpeg 支持多版本共存、随时切换与一键回滚",
          "更新失败自动回滚，不会再出现「装完打不开」",
        ],
      },
      {
        version: "0.1.0",
        releasedAt: "2026-11-05T12:00:00Z",
        channel: "stable",
        notes: [
          "YouTube 报「页面需重载」时自动更新 yt-dlp 后重试",
          "新增 yt-dlp 后台自动更新",
        ],
      },
      {
        version: "0.0.9",
        releasedAt: "2026-11-04T09:30:00Z",
        channel: "stable",
        notes: ["视频报「没有可用清晰度」时自动降级重试"],
      },
    ];
    return {
      current: "0.2.0",
      latest: "0.3.0",
      available: true,
      forced: false,
      releasedAt: "2026-11-06T02:00:00Z",
      notes: history[0].notes,
      size: 14_320_000,
      platform: "windows-x64",
      source: "预览模式（假数据）",
      checkedAt: Date.now(),
      history,
      error: null,
    };
  }

  async appUpdateHistory(): Promise<UpdateHistoryItem[]> {
    return (await this.checkAppUpdate()).history;
  }

  async downloadAppUpdate(): Promise<StagedUpdate> {
    await new Promise((resolve) => setTimeout(resolve, 1600));
    return {
      version: "0.2.0",
      size: 14_320_000,
      stagedPath: "C:\\Program Files\\FluxDL\\fluxdl.exe.new",
      needsRestart: true,
    };
  }

  async applyAppUpdateAndRestart(): Promise<string> {
    return "预览模式不会真的重启；打包版会关闭窗口并在后台完成替换";
  }

  async appVersionList(): Promise<AppVersionList> {
    return {
      active: "0.3.0",
      previous: "0.2.0",
      installed: [
        { version: "0.3.0", active: true, previous: false, size: 9_918_976 },
        { version: "0.2.0", active: false, previous: true, size: 9_500_000 },
      ],
      versionsDir: "C:\\Users\\Gary.Li\\AppData\\Local\\com.fluxdl.desktop\\app-versions",
      managed: true,
      keep: 3,
      warning: null,
    };
  }

  async activateAppVersion(version: string): Promise<string> {
    return `正在切换到 ${version}`;
  }

  async deleteAppVersion(version: string): Promise<string> {
    return `已删除 ${version}`;
  }

  async toolVersionList(tool: string): Promise<ToolVersionList> {
    const isFfmpeg = tool === "ffmpeg";
    const installed = isFfmpeg
      ? [
          { version: "9.0", installed: true, active: true },
          { version: "8.1", installed: true, active: false },
        ]
      : [
          { version: "2025.11.01", installed: true, active: true },
          { version: "2025.10.15", installed: true, active: false },
        ];
    const available = isFfmpeg
      ? ["9.0", "8.1"]
      : ["2025.11.01", "2025.10.31", "2025.10.15"];
    return {
      tool,
      active: installed[0].version,
      previous: installed[1].version,
      latest: available[0],
      updateAvailable: false,
      installed: installed.map((item) => ({
        version: item.version,
        path: `C:\\Users\\Alex\\AppData\\Local\\FluxDL\\tools\\${item.version}`,
        size: isFfmpeg ? 96_000_000 : 23_575_744,
        installed: true,
        active: item.active,
        releasedAt: null,
        notes: item.active ? "当前使用中" : null,
      })),
      available: available.map((version) => ({
        version,
        path: null,
        size: isFfmpeg ? 73_000_000 : 23_575_744,
        installed: installed.some((i) => i.version === version),
        active: installed[0].version === version,
        releasedAt: null,
        notes: null,
      })),
      warning: null,
    };
  }

  async toolInstallVersion(tool: string, version: string): Promise<ToolVersionItem> {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return {
      version,
      path: `C:\\Users\\Alex\\AppData\\Local\\FluxDL\\tools\\${version}`,
      size: 23_575_744,
      installed: true,
      active: false,
      releasedAt: null,
      notes: `预览模式：不会真的下载 ${tool}`,
    };
  }

  async toolActivateVersion(tool: string, version: string): Promise<ToolVersionItem> {
    return {
      version,
      path: `C:\\Users\\Alex\\AppData\\Local\\FluxDL\\tools\\${version}`,
      size: 23_575_744,
      installed: true,
      active: true,
      releasedAt: null,
      notes: `预览模式：${tool} 已切换`,
    };
  }

  async toolRollback(tool: string): Promise<ToolVersionItem> {
    return this.toolActivateVersion(tool, "2025.10.15");
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

  async updateTaskUrl(id: string, newUrl: string, autoResume = true): Promise<Task> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error("未找到对应任务");
    const url = new URL(newUrl.trim());
    task.url = url.toString();
    task.domain = url.hostname;
    task.error = null;
    if (autoResume && task.status !== "completed") {
      task.status = "downloading";
    }
    this.emit({ type: "task", payload: { ...task } });
    return { ...task };
  }

  async verifyTaskChecksum(id: string, expected: string): Promise<ChecksumVerification> {
    const cleaned = expected.trim().replace(/^sha-?256:/i, "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(cleaned)) {
      throw new Error("校验和格式无效：请输入 64 位十六进制 SHA-256");
    }
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error("未找到对应任务");
    task.expectedChecksum = cleaned;
    this.emit({ type: "task", payload: { ...task } });
    if (task.status !== "completed") {
      return { matched: false, pending: true, expected: cleaned, actual: "" };
    }
    return { matched: true, pending: false, expected: cleaned, actual: cleaned };
  }

  async probeUrl(url: string): Promise<UrlProbeInfo> {
    const parsed = new URL(url.trim());
    const name = parsed.pathname.split("/").filter(Boolean).pop() || "download.bin";
    return {
      url: parsed.toString(),
      filename: decodeURIComponent(name),
      totalBytes: 128 * 1024 * 1024,
      resumable: true,
      mime: "application/octet-stream",
    };
  }

  async resolveHubUrl(url: string): Promise<HubListing> {
    return {
      source: url.includes("github.com") ? "GitHub Release" : "HuggingFace",
      title: "preview/demo-repo",
      files: [
        {
          path: "model.safetensors",
          filename: "model.safetensors",
          url: `${url.replace(/\/+$/, "")}/model.safetensors`,
          size: 4_294_967_296,
          sha256: "a".repeat(64),
        },
      ],
    };
  }

  async grabPageLinks(url: string): Promise<GrabResult> {
    return {
      pageUrl: url,
      title: "演示目录索引",
      links: [
        {
          url: `${url.replace(/\/+$/, "")}/release-v1.0.zip`,
          filename: "release-v1.0.zip",
          ext: "zip",
          likelyFile: true,
        },
      ],
    };
  }

  async extractZip(path: string): Promise<string> {
    return path.replace(/\.zip$/i, "");
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
