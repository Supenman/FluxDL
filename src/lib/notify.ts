import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let permissionReady: Promise<boolean> | null = null;

/** 首次使用时申请一次通知权限，之后复用结果。非 Tauri 环境（预览）直接返回 false。 */
async function ensurePermission(): Promise<boolean> {
  if (!permissionReady) {
    permissionReady = (async () => {
      try {
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === "granted";
      } catch {
        return false;
      }
    })();
  }
  return permissionReady;
}

/** 应用窗口处于前台可见时不打扰用户（系统通知只在后台/托盘时有意义）。 */
function isForeground(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** 临时免打扰模式（参考 MDM finish.rs）：不改动用户的长期通知开关。 */
export type NotificationSnoozeMode = "off" | "30m" | "1h" | "8h" | "restart";

const SNOOZE_UNTIL_KEY = "fluxdl.notifySnoozeUntil";
let snoozeUntilRestart = false;

export function setNotificationSnooze(mode: NotificationSnoozeMode): void {
  snoozeUntilRestart = mode === "restart";
  if (typeof window === "undefined") return;
  try {
    if (mode === "off" || mode === "restart") {
      window.localStorage.removeItem(SNOOZE_UNTIL_KEY);
      return;
    }
    const mins = mode === "30m" ? 30 : mode === "1h" ? 60 : 480;
    const until = Date.now() + mins * 60_000;
    window.localStorage.setItem(SNOOZE_UNTIL_KEY, String(until));
  } catch {
    // ignore
  }
}

export function getNotificationSnoozeUntil(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SNOOZE_UNTIL_KEY);
    if (!raw) return null;
    const ts = Number(raw);
    if (!Number.isFinite(ts) || ts <= Date.now()) {
      window.localStorage.removeItem(SNOOZE_UNTIL_KEY);
      return null;
    }
    return ts;
  } catch {
    return null;
  }
}

export function isNotificationSnoozed(): boolean {
  if (snoozeUntilRestart) return true;
  return getNotificationSnoozeUntil() !== null;
}

export function getNotificationSnoozeLabel(): string {
  if (snoozeUntilRestart) return "本次运行已静音";
  const until = getNotificationSnoozeUntil();
  if (!until) return "未开启";
  const remainMin = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  if (remainMin >= 60) {
    const h = Math.floor(remainMin / 60);
    const m = remainMin % 60;
    return m > 0 ? `剩余约 ${h} 小时 ${m} 分钟` : `剩余约 ${h} 小时`;
  }
  return `剩余约 ${remainMin} 分钟`;
}

/**
 * 下载结束通知。失败时不抛错——通知属于锦上添花，不能影响下载主流程。
 */
export async function notifyDownloadFinished(
  title: string,
  body: string,
): Promise<void> {
  if (isForeground() || isNotificationSnoozed()) return;
  const granted = await ensurePermission();
  if (!granted) return;
  try {
    sendNotification({ title, body });
  } catch {
    // ignore
  }
}

let audioContext: AudioContext | null = null;

/**
 * 完成提示音：用 WebAudio 合成两声短音，不打包任何音频文件。
 * 失败（无音频设备 / 自动播放策略）时静默忽略。
 */
export function playFinishSound(failed = false): void {
  if (isNotificationSnoozed()) return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    audioContext ??= new Ctor();
    const ctx = audioContext;
    if (ctx.state === "suspended") void ctx.resume();

    const notes = failed ? [392, 311] : [784, 1046];
    const start = ctx.currentTime;
    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = start + index * 0.11;
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, at);
      // 快速起振 + 指数衰减，听起来像轻提示而不是蜂鸣。
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    });
  } catch {
    // ignore
  }
}

interface PendingFinishItem {
  filename: string;
  failed: boolean;
}

const BATCH_WINDOW_MS = 2200;
let pendingItems: PendingFinishItem[] = [];
let pendingTimer: number | null = null;
let pendingWantNotify = false;
let pendingWantSound = false;

function flushFinishBatch(): void {
  pendingTimer = null;
  const batch = pendingItems;
  const wantNotify = pendingWantNotify;
  const wantSound = pendingWantSound;
  pendingItems = [];
  pendingWantNotify = false;
  pendingWantSound = false;

  if (batch.length === 0 || isNotificationSnoozed()) return;

  const failedCount = batch.filter((b) => b.failed).length;
  const okCount = batch.length - failedCount;

  if (wantSound) {
    playFinishSound(failedCount > 0 && okCount === 0);
  }
  if (!wantNotify) return;

  if (batch.length === 1) {
    const item = batch[0];
    void notifyDownloadFinished(
      item.failed ? "下载失败" : "下载完成",
      item.filename,
    );
    return;
  }

  if (failedCount === 0) {
    void notifyDownloadFinished(
      `批量下载完成（${okCount} 个文件）`,
      `${batch[0].filename} 等 ${okCount} 个任务已完成`,
    );
  } else if (okCount === 0) {
    void notifyDownloadFinished(
      `批量下载失败（${failedCount} 个任务）`,
      `${batch[0].filename} 等 ${failedCount} 个任务失败，请检查日志`,
    );
  } else {
    void notifyDownloadFinished(
      `批量下载结束：${okCount} 个完成，${failedCount} 个失败`,
      `首个文件：${batch[0].filename}`,
    );
  }
}

/**
 * 聚合短时间内连续完成的多个任务为一条汇总通知 + 一次提示音，避免批量队列结束时刷屏。
 */
export function enqueueFinishNotification(
  filename: string,
  failed: boolean,
  opts: { notify: boolean; sound: boolean },
): void {
  if ((!opts.notify && !opts.sound) || isNotificationSnoozed()) return;
  pendingItems.push({ filename, failed });
  if (opts.notify) pendingWantNotify = true;
  if (opts.sound) pendingWantSound = true;

  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
  }
  pendingTimer = window.setTimeout(flushFinishBatch, BATCH_WINDOW_MS);
}
