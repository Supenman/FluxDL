import { useEffect, useRef, useState } from "react";
import { Clock, Maximize2 } from "lucide-react";
import { useStore } from "../store";
import { cx, formatEta, formatSpeed, percent } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

interface HoverPayload {
  id: string;
  x: number;
  y: number;
}

export const HOVER_SHOW = "fluxdl:hover-show";
export const HOVER_MOVE = "fluxdl:hover-move";
export const HOVER_HIDE = "fluxdl:hover-hide";

/** 派发行悬停预览事件（在 TaskRow / TaskTable 行上调用）。 */
export function dispatchHoverShow(id: string, x: number, y: number) {
  window.dispatchEvent(new CustomEvent<HoverPayload>(HOVER_SHOW, { detail: { id, x, y } }));
}
export function dispatchHoverMove(x: number, y: number) {
  window.dispatchEvent(new CustomEvent<HoverPayload>(HOVER_MOVE, { detail: { id: "", x, y } }));
}
export function dispatchHoverHide() {
  window.dispatchEvent(new Event(HOVER_HIDE));
}

/**
 * 悬浮进度预览：鼠标停在任务行上片刻后，在光标旁显示一张轻量卡片
 * （文件名 / 状态 / 进度条 / 速度 / 剩余），点「独立窗口」打开完整进度窗。
 * 用自定义 DOM 事件而非 store 传递光标位置，避免每次 mousemove 触发全树重渲染。
 */
export function TaskHoverPreview() {
  const [payload, setPayload] = useState<HoverPayload | null>(null);
  const tasks = useStore((s) => s.tasks);
  const setProgressId = useStore((s) => s.setProgressId);
  const progressId = useStore((s) => s.progressId);

  const hoveringCard = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onShow = (e: Event) => {
      window.clearTimeout(hideTimer.current);
      setPayload((e as CustomEvent<HoverPayload>).detail);
    };
    const onMove = (e: Event) => {
      const { x, y } = (e as CustomEvent<HoverPayload>).detail;
      setPayload((prev) => (prev ? { ...prev, x, y } : prev));
    };
    const onHide = () => {
      // 轻微延迟，让光标有机会从行移到卡片上；若已进入卡片则取消隐藏。
      hideTimer.current = window.setTimeout(() => {
        if (!hoveringCard.current) setPayload(null);
      }, 140);
    };
    window.addEventListener(HOVER_SHOW, onShow);
    window.addEventListener(HOVER_MOVE, onMove);
    window.addEventListener(HOVER_HIDE, onHide);
    return () => {
      window.clearTimeout(hideTimer.current);
      window.removeEventListener(HOVER_SHOW, onShow);
      window.removeEventListener(HOVER_MOVE, onMove);
      window.removeEventListener(HOVER_HIDE, onHide);
    };
  }, []);

  if (!payload || progressId) return null;
  const task = tasks.find((t) => t.id === payload.id);
  if (!task) return null;

  const pct = percent(task);
  const isActive = task.status === "downloading" || task.status === "connecting";
  // 贴边翻转：卡片约 240×150，靠右/靠下时向左上偏移。
  const left = Math.min(payload.x + 16, window.innerWidth - 252);
  const top = Math.min(payload.y + 16, window.innerHeight - 168);

  return (
    <div
      className="task-hover-preview"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onMouseEnter={() => {
        hoveringCard.current = true;
        window.clearTimeout(hideTimer.current);
      }}
      onMouseLeave={() => {
        hoveringCard.current = false;
        setPayload(null);
      }}
    >
      <div className="thp-head">
        <span className="thp-name" title={task.filename}>{task.filename}</span>
        <StatusBadge status={task.status} scheduledAt={task.scheduledAt} pendingApproval={task.pendingApproval} />
      </div>
      <div className="thp-pct-row">
        <strong>{task.totalBytes ? `${Math.floor(pct)}%` : "—"}</strong>
        <span>{isActive ? formatSpeed(task.speedBps) : "未在传输"}</span>
      </div>
      <div className={cx("thp-bar", isActive && "live")}>
        <div className="thp-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="thp-foot">
        <span><Clock size={11} /> {isActive ? `剩余 ${formatEta(task.etaSeconds)}` : "—"}</span>
        <button
          className="thp-open"
          onClick={() => {
            setProgressId(task.id);
            dispatchHoverHide();
          }}
        >
          <Maximize2 size={11} /> 独立窗口
        </button>
      </div>
    </div>
  );
}
