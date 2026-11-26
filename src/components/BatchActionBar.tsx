import { useState } from "react";
import { CheckSquare, Pause, Play, Trash2, X, Layers } from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import { DEFAULT_QUEUE_ID } from "../lib/queues";

interface BatchActionBarProps {
  selectedIds: string[];
  totalCount: number;
  onSelectAll: () => void;
  onClear: () => void;
}

export function BatchActionBar({
  selectedIds,
  totalCount,
  onSelectAll,
  onClear,
}: BatchActionBarProps) {
  const tasks = useStore((s) => s.tasks);
  const queues = useStore((s) => s.queues);
  const setQueues = useStore((s) => s.setQueues);
  const pushToast = useStore((s) => s.pushToast);

  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (selectedIds.length < 2) return null;

  const idSet = new Set(selectedIds);
  const selectedTasks = tasks.filter((t) => idSet.has(t.id));

  const batchResume = async () => {
    setBusy(true);
    try {
      let count = 0;
      for (const task of selectedTasks) {
        if (task.status === "paused") {
          await backend.resume(task.id);
          count += 1;
        } else if (task.status === "failed") {
          await backend.retry(task.id);
          count += 1;
        }
      }
      pushToast(count > 0 ? `已恢复 ${count} 个任务` : "所选任务均无需恢复", "success");
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const batchPause = async () => {
    setBusy(true);
    try {
      let count = 0;
      for (const task of selectedTasks) {
        if (
          task.status === "downloading" ||
          task.status === "connecting" ||
          task.status === "queued"
        ) {
          await backend.pause(task.id);
          count += 1;
        }
      }
      pushToast(count > 0 ? `已暂停 ${count} 个任务` : "所选任务均未在运行", "success");
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const batchMoveQueue = (queueId: string) => {
    if (!queueId) return;
    const nextAssignment = { ...queues.assignment };
    for (const id of selectedIds) {
      if (queueId === DEFAULT_QUEUE_ID) {
        delete nextAssignment[id];
      } else {
        nextAssignment[id] = queueId;
      }
    }
    setQueues({ ...queues, assignment: nextAssignment });
    const targetName =
      queues.queues.find((q) => q.id === queueId)?.name ?? "默认队列";
    pushToast(`已将 ${selectedIds.length} 个任务移入「${targetName}」`, "success");
  };

  const batchRemove = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      window.setTimeout(() => setConfirmRemove(false), 3500);
      return;
    }
    setBusy(true);
    try {
      for (const id of selectedIds) {
        await backend.remove(id, false);
      }
      pushToast(`已从列表移出 ${selectedIds.length} 个任务（文件保留）`, "success");
      setConfirmRemove(false);
      onClear();
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="batch-bar" role="region" aria-label="批量任务操作">
      <span className="batch-bar-count">
        <CheckSquare size={14} /> 已选 <strong>{selectedIds.length}</strong> 项
      </span>

      <div className="batch-bar-actions">
        <button
          type="button"
          className="batch-bar-btn"
          disabled={busy}
          onClick={() => void batchResume()}
        >
          <Play size={13} /> 继续
        </button>
        <button
          type="button"
          className="batch-bar-btn"
          disabled={busy}
          onClick={() => void batchPause()}
        >
          <Pause size={13} /> 暂停
        </button>

        {queues.queues.length > 1 && (
          <label className="batch-bar-queue" title="批量移入队列">
            <Layers size={13} />
            <select
              defaultValue=""
              disabled={busy}
              onChange={(e) => {
                const val = e.target.value;
                if (val) batchMoveQueue(val);
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                移入队列…
              </option>
              {queues.queues.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="button"
          className={`batch-bar-btn danger${confirmRemove ? " armed" : ""}`}
          disabled={busy}
          onClick={() => void batchRemove()}
        >
          <Trash2 size={13} /> {confirmRemove ? "再次点击确认移出" : "移出列表"}
        </button>

        {selectedIds.length < totalCount && (
          <button
            type="button"
            className="batch-bar-btn ghost"
            onClick={onSelectAll}
          >
            全选 ({totalCount})
          </button>
        )}

        <button
          type="button"
          className="batch-bar-close"
          onClick={onClear}
          title="取消多选 (Esc)"
          aria-label="取消多选"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
