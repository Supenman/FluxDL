import {
  Search,
  Plus,
  Pause,
  Play,
  Square,
  X,
  ChevronDown,
  Trash2,
  Eraser,
  Columns3,
  LayoutList,
  Grid3x3,
  List,
  Settings,
} from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import type { Filter, SortKey } from "../lib/types";
import { cx } from "../lib/format";

const TITLES: Record<Filter, { title: string; subtitle: string }> = {
  all: { title: "全部下载", subtitle: "所有任务按熟悉的工作流集中管理" },
  active: { title: "下载中", subtitle: "正在传输的任务，实时速度与剩余时间" },
  completed: { title: "已完成", subtitle: "已保存到本地的文件" },
  media: { title: "视频下载", subtitle: "由 yt-dlp 驱动的站点视频与音频" },
  paused: { title: "已暂停", subtitle: "随时继续，断点续传不会重头再来" },
  failed: { title: "失败的任务", subtitle: "重试或更换链接后会从已下载位置继续" },
  "category:video": { title: "视频", subtitle: "按文件类型归类的视频文件" },
  "category:document": { title: "文档", subtitle: "按文件类型归类的文档文件" },
  "category:archive": { title: "压缩包", subtitle: "按文件类型归类的压缩文件" },
  "category:other": { title: "其他文件", subtitle: "未归入上述类型的文件" },
};

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "recent", label: "默认分组" },
  { value: "manual", label: "手动排序（可拖拽）" },
  { value: "name", label: "文件名" },
  { value: "size", label: "文件大小" },
  { value: "progress", label: "完成度" },
  { value: "status", label: "状态" },
  { value: "rate", label: "速度" },
  { value: "eta", label: "剩余时间" },
  { value: "added", label: "添加时间" },
  { value: "domain", label: "来源" },
];

export function Toolbar() {
  const tasks = useStore((s) => s.tasks);
  const filter = useStore((s) => s.filter);
  const query = useStore((s) => s.query);
  const sort = useStore((s) => s.sort);
  const selectedId = useStore((s) => s.selectedId);
  const focusedId = useStore((s) => s.focusedId);
  const select = useStore((s) => s.select);
  const setQuery = useStore((s) => s.setQuery);
  const setSort = useStore((s) => s.setSort);
  const compact = useStore((s) => s.compact);
  const setCompact = useStore((s) => s.setCompact);
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
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

  const meta = TITLES[filter];

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
      ids.length ? `已清除 ${ids.length} 条完成记录（文件保留）` : "没有已完成的任务",
      "info",
    );
  };

  return (
    <header className="toolbar toolbar-classic">
      <div className="classic-ribbon" role="toolbar" aria-label="下载主操作栏">
        <div className="classic-ribbon-group">
          <button
            type="button"
            className="ribbon-btn primary"
            onClick={() => setNewTaskOpen(true)}
            title="添加新的下载链接或批量导入 (Ctrl+N)"
          >
            <Plus size={17} />
            <span>添加链接</span>
          </button>

          <span className="ribbon-sep" />

          <button
            type="button"
            className="ribbon-btn"
            onClick={() => void handleResume()}
            disabled={!targetCanResume && resumableCount === 0}
            title={targetCanResume ? `继续「${targetTask?.filename}」` : "继续全部暂停/失败任务"}
          >
            <Play size={16} />
            <span>{targetCanResume ? "继续" : "全部继续"}</span>
          </button>

          <button
            type="button"
            className="ribbon-btn"
            onClick={() => void handlePause()}
            disabled={!targetCanPause && activeCount === 0}
            title={targetCanPause ? `暂停「${targetTask?.filename}」` : "暂停全部活动任务"}
          >
            <Pause size={16} />
            <span>暂停</span>
          </button>

          <button
            type="button"
            className="ribbon-btn"
            onClick={() => void pauseAll()}
            disabled={activeCount === 0}
            title="立即暂停所有正在下载的任务"
          >
            <Square size={15} />
            <span>全部停止</span>
          </button>

          <span className="ribbon-sep" />

          <button
            type="button"
            className="ribbon-btn"
            onClick={() => void removeSelected()}
            disabled={!targetTask}
            title={targetTask ? `从列表移出「${targetTask.filename}」（保留磁盘文件）` : "先选中任务再移出"}
          >
            <Trash2 size={16} />
            <span>删除任务</span>
          </button>

          <button
            type="button"
            className="ribbon-btn"
            onClick={() => void deleteCompleted()}
            disabled={completedCount === 0}
            title="清理所有已完成记录（不会删除磁盘文件）"
          >
            <Eraser size={16} />
            <span>清理已完成</span>
          </button>

          <span className="ribbon-sep" />

          <button
            type="button"
            className="ribbon-btn"
            onClick={() => setView("settings")}
            title="打开设置（队列、站点规则、外观与更新）"
          >
            <Settings size={16} />
            <span>选项</span>
          </button>
        </div>

        <div className="classic-ribbon-tools">
          <div className={cx("search-box", query && "has-value")}>
            <Search size={14} className="search-icon" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文件名、链接或域名"
              spellCheck={false}
              aria-label="搜索任务"
            />
            {query ? (
              <button
                className="search-clear"
                onClick={() => setQuery("")}
                aria-label="清空搜索"
              >
                <X size={13} />
              </button>
            ) : (
              <span className="search-kbd">/</span>
            )}
          </div>

          <div className="select-shell">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="排序方式"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown size={13} className="select-caret" />
          </div>

          <div className="view-switch" role="group" aria-label="视图方式">
            <button
              className={cx("view-switch-btn", viewMode === "table" && "active")}
              onClick={() => setViewMode("table")}
              title="多列数据表视图（IDM 风格）"
              aria-pressed={viewMode === "table"}
            >
              <List size={14} />
            </button>
            <button
              className={cx("view-switch-btn", viewMode === "card" && "active")}
              onClick={() => setViewMode("card")}
              title="卡片视图"
              aria-pressed={viewMode === "card"}
            >
              <Grid3x3 size={14} />
            </button>
          </div>
          {viewMode === "card" && (
            <button
              className="ghost-button view-toggle"
              onClick={() => setCompact(!compact)}
              title={compact ? "切换到舒适视图" : "切换到紧凑视图"}
              aria-pressed={compact}
            >
              {compact ? <LayoutList size={14} /> : <Columns3 size={14} />}
            </button>
          )}
        </div>
      </div>

      <div className="classic-subbar">
        <span className="classic-subbar-title">{meta.title}</span>
        <span className="classic-subbar-meta">
          {meta.subtitle}
          {tasks.length > 0 && ` · 共 ${tasks.length} 项`}
          {targetTask && ` · 当前聚焦：${targetTask.filename}`}
        </span>
      </div>
    </header>
  );
}
