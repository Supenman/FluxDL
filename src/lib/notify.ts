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

/**
 * 下载结束通知。失败时不抛错——通知属于锦上添花，不能影响下载主流程。
 */
export async function notifyDownloadFinished(
  title: string,
  body: string,
): Promise<void> {
  if (isForeground()) return;
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
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
