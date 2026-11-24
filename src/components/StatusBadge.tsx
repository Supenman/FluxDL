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
  pendingApproval,
}: {
  status: TaskStatus;
  scheduledAt?: number | null;
  pendingApproval?: boolean;
}) {
  // 待审核优先：新任务停在 Paused，但语义是「等你允许」，不是普通暂停。
  if (pendingApproval) {
    return (
      <span className="status-badge status-pending">
        <span className="status-dot" />
        待审核
      </span>
    );
  }
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
