import { useEffect, useRef, useState } from "react";
import { Power, X } from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import type { PowerAction } from "../lib/types";

const ACTION_LABELS: Record<Exclude<PowerAction, "none">, string> = {
  exit: "退出 FluxDL",
  sleep: "让电脑进入睡眠",
  shutdown: "关闭计算机",
};

const COUNTDOWN_SECS = 30;

export function PowerActionBanner() {
  const tasks = useStore((s) => s.tasks);
  const powerAction = useStore((s) => s.powerAction);
  const setPowerAction = useStore((s) => s.setPowerAction);
  const pushToast = useStore((s) => s.pushToast);

  const prevActiveRef = useRef(0);
  const [countdown, setCountdown] = useState<number | null>(null);

  const activeCount = tasks.filter(
    (t) => t.status === "downloading" || t.status === "connecting" || t.status === "queued",
  ).length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;

  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeCount;
    if (powerAction === "none") {
      if (countdown !== null) setCountdown(null);
      return;
    }
    if (prev > 0 && activeCount === 0 && completedCount > 0) {
      setCountdown(COUNTDOWN_SECS);
    } else if (activeCount > 0 && countdown !== null) {
      // 有新任务开始下载时自动中止倒计时
      setCountdown(null);
    }
  }, [activeCount, completedCount, powerAction, countdown]);

  useEffect(() => {
    if (countdown === null || powerAction === "none") return;
    if (countdown <= 0) {
      const action = powerAction;
      setCountdown(null);
      setPowerAction("none");
      void backend.executePowerAction(action).catch((err) => {
        pushToast(`执行完成后动作失败：${String(err)}`, "error");
      });
      return;
    }
    const timer = window.setTimeout(() => {
      setCountdown((c) => (c !== null ? c - 1 : null));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, powerAction, setPowerAction, pushToast]);

  if (countdown === null || powerAction === "none") return null;

  const label = ACTION_LABELS[powerAction];

  return (
    <div className="power-countdown-backdrop" role="alertdialog" aria-modal="true" aria-label="下载完成倒计时">
      <div className="power-countdown-card">
        <div className="power-countdown-head">
          <Power size={18} />
          <h3>所有下载已完成</h3>
        </div>
        <p>
          将在 <strong>{countdown}</strong> 秒后自动<strong>{label}</strong>。
        </p>
        <div className="power-countdown-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              setCountdown(null);
              setPowerAction("none");
              pushToast("已取消完成后自动动作", "info");
            }}
          >
            <X size={14} /> 立即取消
          </button>
        </div>
      </div>
    </div>
  );
}
