import {
  Check,
  CheckCircle2,
  Globe,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import type { SortKey, Task } from "../lib/types";
import { backend } from "../lib/backend";
import { useStore } from "../store";
import {
  cx,
  fileStyle,
  formatBytes,
  formatDate,
  formatEta,
  formatSpeed,
  percent,
} from "../lib/format";
import { StatusBadge } from "./StatusBadge";

interface Column {
  key: SortKey | "progress";
  label: string;
  className?: string;
  sortable: boolean;
}

/** MDM 式多列数据表：一列一义，表头可点击排序。原创实现，沿用 FluxDL 的 token 与 format。 */
const COLUMNS: Column[] = [
  { key: "name", label: "文件名", sortable: true },
  { key: "status", label: "状态", sortable: true },
  { key: "size", label: "大小", sortable: true },
  { key: "progress", label: "进度", sortable: true },
  { key: "eta", label: "剩余", sortable: true },
  { key: "rate", label: "速率", sortable: true },
  { key: "added", label: "添加时间", sortable: true },
  { key: "domain", label: "来源", sortable: true },
];

interface TaskTableProps {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function TaskTable({ tasks, selectedId, onSelect }: TaskTableProps) {
  const sort = useStore((s) => s.sort);
  const setSort = useStore((s) => s.setSort);
  const pushToast = useStore((s) => s.pushToast);

  const headerClick = (col: Column) => {
    if (!col.sortable) return;
    // progress 在 SortKey 里叫 progress，其余直接复用列名。
    setSort(col.key as SortKey);
  };

  const toggle = async (task: Task) => {
    const active = task.status === "downloading" || task.status === "connecting";
    try {
      if (active) {
        await backend.pause(task.id);
        pushToast("已暂停", "info");
      } else if (task.pendingApproval) {
        await backend.approve(task.id);
        pushToast("已允许，开始下载", "success");
      } else if (task.status === "failed") {
        await backend.retry(task.id);
        pushToast("正在重试", "success");
      } else {
        await backend.resume(task.id);
        pushToast("已继续下载", "success");
      }
    } catch (error) {
      pushToast(String(error), "error");
    }
  };

  return (
    <table className="task-table">
      <colgroup>
        <col className="col-name" />
        <col className="col-status" />
        <col className="col-size" />
        <col className="col-progress" />
        <col className="col-eta" />
        <col className="col-rate" />
        <col className="col-added" />
        <col className="col-domain" />
        <col className="col-actions" />
      </colgroup>
      <thead>
        <tr>
          {COLUMNS.map((col) => (
            <th
              key={col.key}
              className={cx(col.sortable && "sortable", sort === col.key && "sorted")}
              onClick={() => headerClick(col)}
              title={col.sortable ? `按${col.label}排序` : undefined}
            >
              {col.label}
              {sort === col.key && <span className="sort-arrow">▾</span>}
            </th>
          ))}
          <th className="col-actions" aria-label="操作" />
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => {
          const pct = percent(task);
          const done = task.status === "completed";
          const active = task.status === "downloading" || task.status === "connecting";
          const tone = fileStyle(task);
          return (
            <tr
              key={task.id}
              className={cx(
                "task-table-row",
                selectedId === task.id && "is-selected",
                done && "is-done",
              )}
              onClick={() => onSelect(task.id)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(task.id);
                }
              }}
            >
              <td className="c-name">
                <span className={`table-file-tile tone-${tone.tone}`}>
                  {tone.label || "FILE"}
                </span>
                <span className="c-name-text">
                  <span className="c-name-line" title={task.filename}>
                    {task.filename}
                  </span>
                  <span className="table-mini-track" aria-hidden="true">
                    <span className="table-mini-fill" style={{ width: `${pct}%` }} />
                  </span>
                </span>
              </td>
              <td className="c-status">
                <StatusBadge
                  status={task.status}
                  scheduledAt={task.scheduledAt}
                  pendingApproval={task.pendingApproval}
                />
              </td>
              <td className="c-size num">{task.totalBytes ? formatBytes(task.totalBytes) : "—"}</td>
              <td className="c-progress">
                <span className="table-progress">
                  <span className="table-progress-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="table-progress-pct num">{task.totalBytes ? `${Math.floor(pct)}%` : "—"}</span>
              </td>
              <td className="c-eta num" title={active && task.etaSeconds != null ? formatEta(task.etaSeconds) : undefined}>{active ? (task.etaSeconds != null ? formatEta(task.etaSeconds) : "计算中") : "—"}</td>
              <td className={cx("c-rate num", active && "live")}>{active ? formatSpeed(task.speedBps) : "—"}</td>
              <td className="c-added num">{formatDate(task.createdAt)}</td>
              <td className="c-domain" title={task.domain || ""}>
                <Globe size={11} />
                <span>{task.domain || "本地"}</span>
                {task.speedLimit && <span className="table-tag">限速 {formatSpeed(task.speedLimit)}</span>}
              </td>
              <td className="c-actions">
                <button
                  className="table-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggle(task);
                  }}
                  title={
                    task.pendingApproval
                      ? "允许下载"
                      : active
                        ? "暂停"
                        : task.status === "failed"
                          ? "重试"
                          : "继续"
                  }
                  aria-label="切换任务状态"
                >
                  {task.pendingApproval ? (
                    <Check size={14} />
                  ) : active ? (
                    <Pause size={14} />
                  ) : task.status === "failed" ? (
                    <RefreshCw size={14} />
                  ) : done ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <Play size={14} />
                  )}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
