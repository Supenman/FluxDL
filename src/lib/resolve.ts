import type { TaskStatus } from "./types";

const LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  connecting: "连接中",
  downloading: "下载中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
};

export function statusLabelMaybe(status: TaskStatus): string {
  return LABELS[status];
}
