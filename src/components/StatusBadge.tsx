import type { TaskStatus } from "../lib/types";

const LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  connecting: "连接中",
  downloading: "下载中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
};

export function StatusBadge({
  status,
  scheduledAt,
}: {
  status: TaskStatus;
  scheduledAt?: number | null;
}) {
  // B2：暂停 + 有计划时间 = 等待定时触发，单独标注避免与手动暂停混淆。
  const scheduled = status === "paused" && scheduledAt != null && scheduledAt > 0;
  const label = scheduled ? "定时等待" : LABELS[status];
  return (
    <span className={`status-badge status-${scheduled ? "scheduled" : status}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

export function statusLabel(status: TaskStatus): string {
  return LABELS[status];
}
