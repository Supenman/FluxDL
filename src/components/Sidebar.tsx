import { useMemo } from "react";
import {
  Inbox,
  ArrowDownToLine,
  CheckCircle2,
  Film,
  Pause,
  AlertTriangle,
  Settings,
  Zap,
  Command,
} from "lucide-react";
import { useStore } from "../store";
import { formatSpeed } from "../lib/format";
import { cx } from "../lib/format";
import type { Filter } from "../lib/types";

const NAV: Array<{ id: Filter; label: string; icon: typeof Inbox }> = [
  { id: "all", label: "全部任务", icon: Inbox },
  { id: "active", label: "下载中", icon: ArrowDownToLine },
  { id: "completed", label: "已完成", icon: CheckCircle2 },
  { id: "media", label: "视频", icon: Film },
  { id: "paused", label: "已暂停", icon: Pause },
  { id: "failed", label: "失败", icon: AlertTriangle },
];

export function Sidebar() {
  const tasks = useStore((s) => s.tasks);
  const filter = useStore((s) => s.filter);
  const view = useStore((s) => s.view);
  const setFilter = useStore((s) => s.setFilter);
  const setView = useStore((s) => s.setView);

  const counts = useMemo(() => {
    const active = tasks.filter(
      (t) => t.status === "downloading" || t.status === "connecting",
    ).length;
    return {
      all: tasks.length,
      active,
      completed: tasks.filter((t) => t.status === "completed").length,
      media: tasks.filter((t) => t.kind === "media").length,
      paused: tasks.filter((t) => t.status === "paused").length,
      failed: tasks.filter((t) => t.status === "failed").length,
    };
  }, [tasks]);

  const totalSpeed = useMemo(
    () => tasks.reduce((sum, t) => sum + (t.status === "downloading" ? t.speedBps : 0), 0),
    [tasks],
  );

  const selectFilter = (next: Filter) => {
    setView("tasks");
    setFilter(next);
  };

  return (
    <aside className="sidebar">
      <nav className="nav">
        <div className="nav-label">资料库</div>
        {NAV.map(({ id, label, icon: Icon }) => {
          const count = counts[id] ?? 0;
          const active = view === "tasks" && filter === id;
          return (
            <button
              key={id}
              className={cx("nav-item", active && "active")}
              onClick={() => selectFilter(id)}
            >
              <Icon size={17} className="nav-icon" />
              <span className="nav-text">{label}</span>
              {count > 0 && <span className="nav-count">{count}</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-spacer" />

      <div className="session-card">
        <div className="session-head">
          <Zap size={14} />
          <span>当前总速度</span>
        </div>
        <div className="session-speed">
          {formatSpeed(totalSpeed).replace("/s", "")}
          <span className="session-unit">/s</span>
        </div>
        <div className="session-meta">
          <span className={cx("mini-dot", totalSpeed > 0 && "pulsing")} />
          {counts.active > 0 ? `${counts.active} 个任务传输中` : "引擎空闲"}
        </div>
        <div className="session-bar">
          {tasks
            .filter((t) => t.status === "downloading")
            .slice(0, 6)
            .map((t) => (
              <span
                key={t.id}
                className="session-bar-seg"
                style={{ flexGrow: Math.max(0.2, t.speedBps / Math.max(totalSpeed, 1)) }}
              />
            ))}
          {counts.active === 0 && <span className="session-bar-idle" />}
        </div>
      </div>

      <button
        className={cx("nav-item settings-nav", view === "settings" && "active")}
        onClick={() => setView("settings")}
      >
        <Settings size={17} className="nav-icon" />
        <span className="nav-text">设置</span>
      </button>

      <div className="shortcut-hint">
        <Command size={12} />
        <span>
          按 <kbd>Ctrl</kbd> <kbd>K</kbd> 打开命令面板
        </span>
      </div>
    </aside>
  );
}
