import { Search, Plus, Pause, Play, X, ChevronDown } from "lucide-react";
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
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
  const pushToast = useStore((s) => s.pushToast);

  const activeCount = tasks.filter(
    (t) => t.status === "downloading" || t.status === "connecting",
  ).length;
  const pausedCount = tasks.filter(
    (t) => t.status === "paused" || t.status === "failed",
  ).length;

  const meta = TITLES[filter];

  const pauseAll = async () => {
    await backend.pauseAll();
    pushToast("已暂停全部任务", "info");
  };

  const resumeAll = async () => {
    await backend.resumeAll();
    pushToast("已恢复全部任务", "success");
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

        {activeCount > 0 && (
          <button className="ghost-button" onClick={pauseAll} title="暂停全部">
            <Pause size={14} />
            <span>全部暂停</span>
          </button>
        )}
        {pausedCount > 0 && (
          <button className="ghost-button" onClick={resumeAll} title="继续全部">
            <Play size={14} />
            <span>全部继续</span>
          </button>
        )}

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
