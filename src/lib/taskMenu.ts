import type { Task } from "./types";
import type { MenuItem } from "../components/ContextMenu";
import { backend } from "./backend";

interface BuildOptions {
  task: Task;
  pushToast: (message: string, tone?: "info" | "success" | "error") => void;
  onSelect?: (id: string | null) => void;
  selected?: boolean;
  onOpenProgress?: (id: string) => void;
  onOpenDetail?: (id: string) => void;
}

/**
 * 右键菜单项的统一构造：卡片行与数据表共用，避免两处各写一份。
 * 只做「发命令 + 提示」，不改任务状态来源（状态始终来自引擎事件）。
 */
export function buildTaskMenu({
  task,
  pushToast,
  onSelect,
  selected,
  onOpenProgress,
  onOpenDetail,
}: BuildOptions): MenuItem[] {
  const isActive = task.status === "downloading" || task.status === "connecting";
  const isFailed = task.status === "failed";
  const isPaused = task.status === "paused";
  const pending = task.pendingApproval === true;
  const done = task.status === "completed";

  const exec = (action: () => Promise<void>, ok?: string, fail?: string) => {
    void action().catch((error) => pushToast(fail ? `${fail}：${error}` : String(error), "error"));
    if (ok) pushToast(ok, "success");
  };

  const copy = (text: string, label: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => pushToast(`已复制${label}`, "success"))
      .catch(() => pushToast("复制失败，剪贴板不可用", "error"));
  };

  const items: MenuItem[] = [];

  if (pending) {
    items.push({
      id: "approve",
      label: "允许下载",
      onSelect: () => exec(() => backend.approve(task.id), "已允许，开始下载"),
    });
  } else if (isActive) {
    items.push({
      id: "pause",
      label: "暂停",
      onSelect: () => exec(() => backend.pause(task.id), "已暂停"),
    });
  } else if (isFailed) {
    items.push({
      id: "retry",
      label: "重试",
      onSelect: () => exec(() => backend.retry(task.id), "正在重试"),
    });
  } else if (isPaused) {
    items.push({
      id: "resume",
      label: "继续下载",
      onSelect: () => exec(() => backend.resume(task.id), "已继续下载"),
    });
  }

  if (done) {
    items.push({
      id: "open",
      label: "打开文件",
      onSelect: () => exec(() => backend.openFile(task.savePath)),
    });
  }

  items.push({
    id: "folder",
    label: "打开所在文件夹",
    onSelect: () => exec(() => backend.openPath(task.savePath)),
  });

  if (onOpenDetail) {
    items.push({
      id: "detail",
      label: "查看详情",
      onSelect: () => onOpenDetail(task.id),
    });
  }

  if (onOpenProgress) {
    items.push({
      id: "progress",
      label: "独立进度窗口",
      onSelect: () => onOpenProgress(task.id),
    });
  }

  items.push(
    {
      id: "copy-url",
      label: "复制下载链接",
      onSelect: () => copy(task.url, "链接"),
    },
    {
      id: "copy-name",
      label: "复制文件名",
      onSelect: () => copy(task.filename, "文件名"),
    },
    {
      id: "remove",
      label: pending ? "拒绝并移出列表" : "移出列表（保留文件）",
      danger: true,
      onSelect: () => {
        void backend
          .remove(task.id, false)
          .then(() => {
            if (selected && onSelect) onSelect(null);
            pushToast(pending ? "已拒绝该下载" : "已移出列表，本地文件仍保留", "info");
          })
          .catch((error) => pushToast(String(error), "error"));
      },
    },
  );

  return items;
}
