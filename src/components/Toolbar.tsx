import {
  Search,
  PlusCircle,
  PlayCircle,
  PauseCircle,
  Hand,
  Trash2,
  CheckSquare,
  Settings,
  Layers,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import { cx } from "../lib/format";

export function Toolbar() {
  const tasks = useStore((s) => s.tasks);
  const query = useStore((s) => s.query);
  const selectedId = useStore((s) => s.selectedId);
  const focusedId = useStore((s) => s.focusedId);
  const select = useStore((s) => s.select);
  const setQuery = useStore((s) => s.setQuery);
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const pushToast = useStore((s) => s.pushToast);

  const targetId = selectedId ?? focusedId;
  const targetTask = targetId ? tasks.find((t) => t.id === targetId) ?? null : null;

  const activeCount = tasks.filter(
    (t) => t.status === "downloading" || t.status === "connecting" || t.status === "queued",
  ).length;
  const resumableCount = tasks.filter(
    (t) => (t.status === "paused" && !t.pendingApproval) || t.status === "failed",
  ).length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;

  const targetCanResume = Boolean(
    targetTask &&
      ((targetTask.status === "paused" && !targetTask.pendingApproval) ||
        targetTask.status === "failed"),
  );
  const targetCanPause = Boolean(
    targetTask &&
      (targetTask.status === "downloading" ||
        targetTask.status === "connecting" ||
        targetTask.status === "queued"),
  );

  const handleResume = async () => {
    try {
      if (targetTask && targetCanResume) {
        if (targetTask.status === "failed") await backend.retry(targetTask.id);
        else await backend.resume(targetTask.id);
        pushToast(`已继续：${targetTask.filename}`, "success");
      } else {
        await backend.resumeAll();
        pushToast("已恢复全部可继续任务", "success");
      }
    } catch (error) {
      pushToast(String(error), "error");
    }
  };

  const handlePause = async () => {
    try {
      if (targetTask && targetCanPause) {
        await backend.pause(targetTask.id);
        pushToast(`已暂停：${targetTask.filename}`, "info");
      } else {
        await backend.pauseAll();
        pushToast("已暂停全部任务", "info");
      }
    } catch (error) {
      pushToast(String(error), "error");
    }
  };

  const pauseAll = async () => {
    try {
      await backend.pauseAll();
      pushToast("已暂停全部任务", "info");
    } catch (error) {
      pushToast(String(error), "error");
    }
  };

  const removeSelected = async () => {
    if (!targetTask) return;
    try {
      await backend.remove(targetTask.id, false);
      if (selectedId === targetTask.id) select(null);
      pushToast(`已移出：${targetTask.filename}（文件保留）`, "info");
    } catch (error) {
      pushToast(String(error), "error");
    }
  };

  const deleteCompleted = async () => {
    const ids = tasks.filter((t) => t.status === "completed").map((t) => t.id);
    for (const id of ids) {
      await backend.remove(id, false);
    }
    pushToast(
      ids.length ? `已清理 ${ids.length} 条完成记录（文件保留）` : "没有已完成的任务",
      "info",
    );
  };

  return (
    <header className="idm-toolbar" role="toolbar" aria-label="下载主工具栏">
      <div className="idm-toolbar-actions">
        <button
          type="button"
          className="idm-tb-btn tone-add"
          onClick={() => setNewTaskOpen(true)}
          title="添加下载链接或批量导入 (Ctrl+N)"
        >
          <PlusCircle size={22} strokeWidth={1.7} />
          <span>添加链接</span>
        </button>

        <button
          type="button"
          className="idm-tb-btn tone-resume"
          onClick={() => void handleResume()}
          disabled={!targetCanResume && resumableCount === 0}
          title={targetCanResume ? `继续「${targetTask?.filename}」` : "继续全部任务"}
        >
          <PlayCircle size={22} strokeWidth={1.7} />
          <span>继续</span>
        </button>

        <button
          type="button"
          className="idm-tb-btn tone-stop"
          onClick={() => void handlePause()}
          disabled={!targetCanPause && activeCount === 0}
          title={targetCanPause ? `暂停「${targetTask?.filename}」` : "暂停活动任务"}
        >
          <PauseCircle size={22} strokeWidth={1.7} />
          <span>停止</span>
        </button>

        <button
          type="button"
          className="idm-tb-btn tone-stopall"
          onClick={() => void pauseAll()}
          disabled={activeCount === 0}
          title="停止所有正在进行的下载"
        >
          <Hand size={22} strokeWidth={1.7} />
          <span>全部停止</span>
        </button>

        <button
          type="button"
          className="idm-tb-btn tone-delete"
          onClick={() => void removeSelected()}
          disabled={!targetTask}
          title={targetTask ? `移出「${targetTask.filename}」（保留磁盘文件）` : "先选中任务再删除"}
        >
          <Trash2 size={22} strokeWidth={1.7} />
          <span>删除</span>
        </button>

        <button
          type="button"
          className="idm-tb-btn tone-clean"
          onClick={() => void deleteCompleted()}
          disabled={completedCount === 0}
          title="清理全部已完成记录（不删磁盘文件）"
        >
          <CheckSquare size={22} strokeWidth={1.7} />
          <span>清理已完成</span>
        </button>

        <button
          type="button"
          className={cx("idm-tb-btn tone-options", view === "settings" && "is-active")}
          onClick={() => setView(view === "settings" ? "tasks" : "settings")}
          title="打开或退出选项设置"
        >
          <Settings size={22} strokeWidth={1.7} />
          <span>选项</span>
        </button>

        <button
          type="button"
          className="idm-tb-btn tone-queue"
          onClick={() => setView("settings")}
          title="管理下载队列与定时计划"
        >
          <Layers size={22} strokeWidth={1.7} />
          <span>计划队列</span>
        </button>
      </div>

      <div className="idm-toolbar-search">
        <div className={cx("search-box idm-search", query && "has-value")}>
          <Search size={13} className="search-icon" />
          <input
            value={query}
            onChange={(e) => {
              if (view !== "tasks") setView("tasks");
              setQuery(e.target.value);
            }}
            placeholder="查找任务…"
            spellCheck={false}
            aria-label="查找任务"
          />
          {query && (
            <button
              className="search-clear"
              onClick={() => setQuery("")}
              aria-label="清空查找"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
