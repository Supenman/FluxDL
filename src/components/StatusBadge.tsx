import type { TaskStatus } from "../lib/types";

const LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  connecting: "连接中",
  downloading: "下载中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {LABELS[status]}
    </span>
  );
}

export function statusLabel(status: TaskStatus): string {
  return LABELS[status];
}
