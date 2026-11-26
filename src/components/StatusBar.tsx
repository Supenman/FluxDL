import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clipboard,
  Wifi,
  ArrowDownToLine,
  Command,
  Gauge,
  Bell,
  BellOff,
  Power,
} from "lucide-react";
import { useStore } from "../store";
import { formatBytes, formatSpeed } from "../lib/format";
import { backend, isTauri } from "../lib/backend";
import type { PowerAction } from "../lib/types";
import {
  getNotificationSnoozeLabel,
  isNotificationSnoozed,
  setNotificationSnooze,
  type NotificationSnoozeMode,
} from "../lib/notify";

const GLOBAL_LIMITS: Array<{ label: string; value: number | null }> = [
  { label: "不限速", value: null },
  { label: "1 MB/s", value: 1024 * 1024 },
  { label: "2 MB/s", value: 2 * 1024 * 1024 },
  { label: "5 MB/s", value: 5 * 1024 * 1024 },
  { label: "10 MB/s", value: 10 * 1024 * 1024 },
  { label: "20 MB/s", value: 20 * 1024 * 1024 },
];

const POWER_OPTIONS: Array<{ value: PowerAction; label: string }> = [
  { value: "none", label: "完成后无动作" },
  { value: "exit", label: "完成后退出 FluxDL" },
  { value: "sleep", label: "完成后自动睡眠" },
  { value: "shutdown", label: "完成后自动关机" },
];

const SNOOZE_OPTIONS: Array<{ mode: NotificationSnoozeMode; label: string }> = [
  { mode: "off", label: "关闭免打扰" },
  { mode: "30m", label: "静音 30 分钟" },
  { mode: "1h", label: "静音 1 小时" },
  { mode: "8h", label: "静音 8 小时" },
  { mode: "restart", label: "本次运行静音" },
];

export function StatusBar() {
  const tasks = useStore((s) => s.tasks);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const pushToast = useStore((s) => s.pushToast);
  const selectedId = useStore((s) => s.selectedId);
  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : undefined;

  const powerAction = useStore((s) => s.powerAction);
  const setPowerAction = useStore((s) => s.setPowerAction);
  const [openMenu, setOpenMenu] = useState<"limit" | "snooze" | "power" | null>(null);
  const [snoozed, setSnoozed] = useState(() => isNotificationSnoozed());
  const [snoozeLabel, setSnoozeLabel] = useState(() => getNotificationSnoozeLabel());
  const menuHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (menuHostRef.current && !menuHostRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSnoozed(isNotificationSnoozed());
      setSnoozeLabel(getNotificationSnoozeLabel());
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const { speed, active, transferred } = useMemo(() => {
    let speed = 0;
    let active = 0;
    let transferred = 0;
    for (const task of tasks) {
      transferred += task.downloadedBytes;
      if (task.status === "downloading" || task.status === "connecting") {
        active += 1;
        speed += task.speedBps;
      }
    }
    return { speed, active, transferred };
  }, [tasks]);

  const applyGlobalLimit = async (value: number | null) => {
    setOpenMenu(null);
    const next = { ...settings, globalSpeedLimit: value };
    setSettings({ globalSpeedLimit: value });
    try {
      await backend.setEngineOptions(next);
      pushToast(
        value ? `全局限速已设为 ${formatSpeed(value)}` : "已取消全局限速",
        "success",
      );
    } catch (error) {
      pushToast(String(error), "error");
    }
  };

  const applySnooze = (mode: NotificationSnoozeMode, label: string) => {
    setNotificationSnooze(mode);
    setSnoozed(isNotificationSnoozed());
    setSnoozeLabel(getNotificationSnoozeLabel());
    setOpenMenu(null);
    pushToast(mode === "off" ? "已恢复下载提醒" : `通知已${label}`, "success");
  };

  const currentLimit = settings.globalSpeedLimit ?? null;

  return (
    <footer className="statusbar" role="status" aria-label="下载引擎状态">
      <div className="status-left">
        <span className="status-item">
          <Wifi size={12} className={active > 0 ? "status-live" : "status-idle"} />
          {active > 0 ? `${active} 个任务传输中` : "引擎空闲"}
        </span>
        <span className="status-divider" />
        <span className="status-item">
          <ArrowDownToLine size={12} />
          {formatSpeed(speed)}
        </span>
        <span className="status-divider" />
        <span className="status-item dim">累计 {formatBytes(transferred)}</span>
        {selected && (
          <>
            <span className="status-divider" />
            <span className="status-item" title={selected.filename}>
              已选中 · {selected.filename}
            </span>
          </>
        )}
        <span className="status-divider" />
        <span className="status-item dim">
          <Clipboard size={12} />
          剪贴板监听{settings.clipboardWatch ? "已开启" : "已关闭"}
        </span>
      </div>
      <div className="status-right" ref={menuHostRef}>
        <div className="status-popover-wrap">
          <button
            type="button"
            className={`status-pill${currentLimit ? " is-active" : ""}`}
            onClick={() => setOpenMenu(openMenu === "limit" ? null : "limit")}
            title="点击快速切换全局限速"
          >
            <Gauge size={12} />
            {currentLimit ? `限速 ${formatSpeed(currentLimit)}` : "不限速"}
          </button>
          {openMenu === "limit" && (
            <div className="status-popover" role="menu" aria-label="全局限速">
              {GLOBAL_LIMITS.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  role="menuitem"
                  className={`status-popover-item${currentLimit === opt.value ? " active" : ""}`}
                  onClick={() => void applyGlobalLimit(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="status-popover-wrap">
          <button
            type="button"
            className={`status-pill${snoozed ? " is-active" : ""}`}
            onClick={() => setOpenMenu(openMenu === "snooze" ? null : "snooze")}
            title={snoozed ? `通知免打扰中（${snoozeLabel}）` : "点击开启临时免打扰"}
          >
            {snoozed ? <BellOff size={12} /> : <Bell size={12} />}
            {snoozed ? `免打扰 · ${snoozeLabel}` : "提醒开启"}
          </button>
          {openMenu === "snooze" && (
            <div className="status-popover" role="menu" aria-label="通知免打扰">
              {SNOOZE_OPTIONS.map((opt) => (
                <button
                  key={opt.mode}
                  type="button"
                  role="menuitem"
                  className="status-popover-item"
                  onClick={() => applySnooze(opt.mode, opt.label)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="status-popover-wrap">
          <button
            type="button"
            className={`status-pill${powerAction !== "none" ? " is-active" : ""}`}
            onClick={() => setOpenMenu(openMenu === "power" ? null : "power")}
            title="设置全部下载完成后的自动电源动作"
          >
            <Power size={12} />
            {powerAction === "none"
              ? "完成后"
              : powerAction === "exit"
                ? "完后退出"
                : powerAction === "sleep"
                  ? "完后睡眠"
                  : "完后关机"}
          </button>
          {openMenu === "power" && (
            <div className="status-popover" role="menu" aria-label="下载完成后动作">
              {POWER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitem"
                  className={`status-popover-item${powerAction === opt.value ? " active" : ""}`}
                  onClick={() => {
                    setPowerAction(opt.value);
                    setOpenMenu(null);
                    pushToast(
                      opt.value === "none" ? "已关闭完成后自动动作" : `已设置：${opt.label}`,
                      "info",
                    );
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="status-divider" />
        <span className="status-item dim">
          {isTauri ? "FluxDL 桌面引擎" : "浏览器预览"}
        </span>
        <span className="status-divider" />
        <span className="status-item dim kbd-hint">
          <Command size={11} /> K 命令面板
        </span>
      </div>
    </footer>
  );
}
