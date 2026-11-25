import { useMemo, useRef, useState, useEffect } from "react";
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
  FileText,
  Package,
  Files,
  ChevronDown,
  Layers,
  Plus,
} from "lucide-react";
import { useStore, fileCategory } from "../store";
import { formatSpeed } from "../lib/format";
import { cx } from "../lib/format";
import { newQueue, tasksInQueue } from "../lib/queues";
import type { Filter } from "../lib/types";

interface NavItem {
  id: Filter;
  label: string;
  icon: typeof Inbox;
}

const STATUS_NAV: NavItem[] = [
  { id: "all", label: "全部任务", icon: Inbox },
  { id: "active", label: "下载中", icon: ArrowDownToLine },
  { id: "completed", label: "已完成", icon: CheckCircle2 },
  { id: "paused", label: "已暂停", icon: Pause },
  { id: "failed", label: "失败", icon: AlertTriangle },
];

const TYPE_NAV: NavItem[] = [
  { id: "category:video", label: "视频", icon: Film },
  { id: "category:document", label: "文档", icon: FileText },
  { id: "category:archive", label: "压缩包", icon: Package },
  { id: "category:other", label: "其他", icon: Files },
];

const WIDTH_KEY = "fluxdl:sidebar-width";
const WIDTH_MIN = 180;
const WIDTH_MAX = 360;

function readWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
  } catch {
    // ignore
  }
  return 232;
}

export function Sidebar() {
  const tasks = useStore((s) => s.tasks);
  const filter = useStore((s) => s.filter);
  const view = useStore((s) => s.view);
  const setFilter = useStore((s) => s.setFilter);
  const setView = useStore((s) => s.setView);
  const queues = useStore((s) => s.queues);
  const setQueues = useStore((s) => s.setQueues);
  const queueFilter = useStore((s) => s.queueFilter);
  const setQueueFilter = useStore((s) => s.setQueueFilter);
  const pushToast = useStore((s) => s.pushToast);
  const [typesOpen, setTypesOpen] = useState(true);
  const [queuesOpen, setQueuesOpen] = useState(true);
  const [width, setWidth] = useState<number>(readWidth);

  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
  }, [width]);

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const move = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, cur.startW + (ev.clientX - cur.startX)));
      setWidth(next);
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        // ignore
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const counts = useMemo(() => {
    const active = tasks.filter(
      (t) => t.status === "downloading" || t.status === "connecting",
    ).length;
    const byCat = { video: 0, document: 0, archive: 0, other: 0 };
    for (const t of tasks) byCat[fileCategory(t)] += 1;
    return {
      all: tasks.length,
      active,
      completed: tasks.filter((t) => t.status === "completed").length,
      media: tasks.filter((t) => t.kind === "media").length,
      paused: tasks.filter((t) => t.status === "paused" && !t.pendingApproval).length,
      failed: tasks.filter((t) => t.status === "failed").length,
      "category:video": byCat.video,
      "category:document": byCat.document,
      "category:archive": byCat.archive,
      "category:other": byCat.other,
    } as Record<Filter, number>;
  }, [tasks]);

  const totalSpeed = useMemo(
    () => tasks.reduce((sum, t) => sum + (t.status === "downloading" ? t.speedBps : 0), 0),
    [tasks],
  );

  const selectFilter = (next: Filter) => {
    setView("tasks");
    setFilter(next);
  };

  const selectQueue = (id: string | null) => {
    setView("tasks");
    setFilter("all");
    setQueueFilter(id);
  };

  const renderItem = ({ id, label, icon: Icon }: NavItem) => {
    const count = counts[id] ?? 0;
    const active = view === "tasks" && filter === id;
    return (
      <button
        key={id}
        className={cx("nav-item", active && "active")}
        onClick={() => selectFilter(id)}
        aria-current={active ? "true" : undefined}
      >
        <Icon size={17} className="nav-icon" />
        <span className="nav-text">{label}</span>
        {count > 0 && <span className="nav-count">{count}</span>}
      </button>
    );
  };

  return (
    <aside className="sidebar" style={{ width }}>
      <nav className="nav">
        <div className="nav-label">状态</div>
        {STATUS_NAV.map(renderItem)}

        <button
          className="nav-group-toggle"
          onClick={() => setTypesOpen((v) => !v)}
          aria-expanded={typesOpen}
        >
          <span className="nav-label">按类型</span>
          <ChevronDown size={13} className={cx("group-caret", typesOpen && "open")} />
        </button>
        {typesOpen && <div className="nav-subtree">{TYPE_NAV.map(renderItem)}</div>}

        <button
          className="nav-group-toggle"
          onClick={() => setQueuesOpen((v) => !v)}
          aria-expanded={queuesOpen}
        >
          <span className="nav-label">队列</span>
          <ChevronDown size={13} className={cx("group-caret", queuesOpen && "open")} />
        </button>
        {queuesOpen && (
          <div className="nav-subtree queue-subtree">
            <button
              className={cx("nav-item nav-queue", queueFilter === null && "active")}
              onClick={() => selectQueue(null)}
              aria-current={queueFilter === null ? "true" : undefined}
            >
              <Layers size={16} className="nav-icon" />
              <span className="nav-text">全部队列</span>
              <span className="nav-count">{tasks.length}</span>
            </button>
            {queues.queues.map((q) => {
              const inQ = tasksInQueue(queues, tasks, q.id);
              const active = queueFilter === q.id;
              return (
                <button
                  key={q.id}
                  className={cx("nav-item nav-queue", active && "active", !q.enabled && "queue-disabled")}
                  onClick={() => selectQueue(q.id)}
                  title={`${q.name}${q.enabled ? "" : "（已停用）"}`}
                  aria-current={active ? "true" : undefined}
                >
                  <span className="queue-dot" style={{ background: q.color }} />
                  <span className="nav-text">{q.name}</span>
                  {inQ.length > 0 && <span className="nav-count">{inQ.length}</span>}
                </button>
              );
            })}
            <button
              className="queue-add"
              onClick={() => {
                const q = newQueue(`队列 ${queues.queues.length}`, queues.queues);
                setQueues({ ...queues, queues: [...queues.queues, q] });
                pushToast(`已创建队列「${q.name}」，可在设置中编辑`, "success");
              }}
              title="新建队列"
            >
              <Plus size={13} /> 新建队列
            </button>
          </div>
        )}
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

      <div
        className="sidebar-resizer"
        onPointerDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整侧栏宽度"
        title="拖动调整宽度"
      />
    </aside>
  );
}
