import { Search, Plus, Pause, Play, X, ChevronDown, Trash2, Columns3, LayoutList } from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import type { Filter, SortKey } from "../lib/types";
import { cx } from "../lib/format";

const TITLES: Record<Filter, { title: string; subtitle: string }> = {
  all: { title: "全部任务", subtitle: "所有下载都在这里，按状态自动分组" },
  active: { title: "下载中", subtitle: "正在传输的任务，实时速度与剩余时间" },
  completed: { title: "已完成", subtitle: "已保存到本地的文件" },
  media: { title: "视频下载", subtitle: "由 yt-dlp 驱动的站点视频与音频" },
  paused: { title: "已暂停", subtitle: "随时继续，断点续传不会重头再来" },
  failed: { title: "失败的任务", subtitle: "重试会从已下载的位置继续" },
  "category:video": { title: "视频", subtitle: "按文件类型归类的视频文件" },
  "category:document": { title: "文档", subtitle: "按文件类型归类的文档文件" },
  "category:archive": { title: "压缩包", subtitle: "按文件类型归类的压缩文件" },
  "category:other": { title: "其他文件", subtitle: "未归入上述类型的文件" },
};

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "recent", label: "最近添加" },
  { value: "name", label: "文件名" },
  { value: "size", label: "文件大小" },
  { value: "progress", label: "完成度" },
];

export function Toolbar() {
  const tasks = useStore((s) => s.tasks);
  const filter = useStore((s) => s.filter);
  const query = useStore((s) => s.query);
  const sort = useStore((s) => s.sort);
  const setQuery = useStore((s) => s.setQuery);
  const setSort = useStore((s) => s.setSort);
  const compact = useStore((s) => s.compact);
  const setCompact = useStore((s) => s.setCompact);
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
  const pushToast = useStore((s) => s.pushToast);

  const activeCount = tasks.filter(
    (t) => t.status === "downloading" || t.status === "connecting",
  ).length;
  const pausedCount = tasks.filter(
    (t) => (t.status === "paused" && !t.pendingApproval) || t.status === "failed",
  ).length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;

  const meta = TITLES[filter];

  const pauseAll = async () => {
    await backend.pauseAll();
    pushToast("已暂停全部任务", "info");
  };

  const resumeAll = async () => {
    await backend.resumeAll();
    pushToast("已恢复全部任务", "success");
  };

  const deleteCompleted = async () => {
    const ids = tasks.filter((t) => t.status === "completed").map((t) => t.id);
    for (const id of ids) {
      await backend.remove(id, false);
    }
    pushToast(ids.length ? `已清除 ${ids.length} 条完成记录（文件保留）` : "没有已完成的任务", "info");
  };

  return (
    <header className="toolbar">
      <div className="toolbar-heading">
        <h1>{meta.title}</h1>
        <p>
          {meta.subtitle}
          {tasks.length > 0 && (
            <span className="toolbar-count"> · {tasks.length} 个任务</span>
          )}
        </p>
      </div>

      <div className="toolbar-actions">
        <button
          className="ghost-button view-toggle"
          onClick={() => setCompact(!compact)}
          title={compact ? "切换到舒适视图" : "切换到紧凑多列视图"}
          aria-pressed={compact}
        >
          {compact ? <LayoutList size={14} /> : <Columns3 size={14} />}
          <span>{compact ? "舒适" : "紧凑"}</span>
        </button>
        <div className={cx("search-box", query && "has-value")}>
          <Search size={15} className="search-icon" />
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

        <button
          className="ghost-button"
          onClick={pauseAll}
          disabled={activeCount === 0}
          title={activeCount === 0 ? "没有正在进行的任务" : "暂停全部"}
        >
          <Pause size={14} />
          <span>全部暂停</span>
        </button>
        <button
          className="ghost-button"
          onClick={resumeAll}
          disabled={pausedCount === 0}
          title={pausedCount === 0 ? "没有可继续的任务" : "继续全部"}
        >
          <Play size={14} />
          <span>全部继续</span>
        </button>
        <button
          className="ghost-button"
          onClick={deleteCompleted}
          disabled={completedCount === 0}
          title={completedCount === 0 ? "没有已完成的任务" : "清除已完成记录（保留文件）"}
        >
          <Trash2 size={14} />
          <span>清除已完成</span>
        </button>

        <button
          className="primary-button"
          onClick={() => setNewTaskOpen(true)}
        >
          <Plus size={16} />
          新建下载
        </button>
      </div>
    </header>
  );
}
