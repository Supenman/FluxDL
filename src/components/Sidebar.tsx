import { useMemo, useRef, useState, useEffect } from "react";
import {
  Inbox,
  ArrowDownToLine,
  CheckCircle2,
  Film,
  Pause,
  AlertTriangle,
  FileText,
  Package,
  Files,
  ChevronDown,
  Layers,
  Plus,
} from "lucide-react";
import { useStore, fileCategory } from "../store";
import { cx } from "../lib/format";
import { newQueue, tasksInQueue } from "../lib/queues";
import type { Filter } from "../lib/types";

interface NavItem {
  id: Filter;
  label: string;
  icon: typeof Inbox;
}

const UNFINISHED_NAV: NavItem[] = [
  { id: "active", label: "下载中", icon: ArrowDownToLine },
  { id: "paused", label: "已暂停", icon: Pause },
  { id: "failed", label: "失败", icon: AlertTriangle },
];

const TYPE_NAV: NavItem[] = [
  { id: "category:video", label: "视频", icon: Film },
  { id: "category:document", label: "文档", icon: FileText },
  { id: "category:archive", label: "压缩包", icon: Package },
  { id: "category:other", label: "其他", icon: Files },
];

const WIDTH_KEY = "fluxdl:sidebar-width:v2";
const WIDTH_MIN = 152;
const WIDTH_MAX = 360;

function readWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
  } catch {
    // ignore
  }
  return 178;
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
  const [allOpen, setAllOpen] = useState(true);
  const [unfinishedOpen, setUnfinishedOpen] = useState(true);
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

  const selectFilter = (next: Filter) => {
    setView("tasks");
    setQueueFilter(null);
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
    <aside className="sidebar sidebar-idm" style={{ width }}>
      <div className="idm-cat-head">分类</div>
      <nav className="nav idm-tree-nav" aria-label="下载分类目录树">
        <div className="nav-tree-row">
          <button
            type="button"
            className="nav-tree-caret"
            onClick={() => setAllOpen((v) => !v)}
            aria-expanded={allOpen}
            aria-label="展开或折叠全部下载分类"
          >
            <ChevronDown size={13} className={cx("group-caret", allOpen && "open")} />
          </button>
          <button
            className={cx("nav-item nav-tree-root", view === "tasks" && filter === "all" && queueFilter === null && "active")}
            onClick={() => selectFilter("all")}
            aria-current={view === "tasks" && filter === "all" && queueFilter === null ? "true" : undefined}
          >
            <Inbox size={17} className="nav-icon" />
            <span className="nav-text">全部下载</span>
            {counts.all > 0 && <span className="nav-count">{counts.all}</span>}
          </button>
        </div>
        {allOpen && <div className="nav-subtree">{TYPE_NAV.map(renderItem)}</div>}

        <button
          className="nav-group-toggle"
          onClick={() => setUnfinishedOpen((v) => !v)}
          aria-expanded={unfinishedOpen}
        >
          <span className="nav-label">
            未完成 ({counts.active + counts.paused + counts.failed})
          </span>
          <ChevronDown size={13} className={cx("group-caret", unfinishedOpen && "open")} />
        </button>
        {unfinishedOpen && <div className="nav-subtree">{UNFINISHED_NAV.map(renderItem)}</div>}

        <button
          className={cx("nav-item", view === "tasks" && filter === "completed" && queueFilter === null && "active")}
          onClick={() => selectFilter("completed")}
          aria-current={view === "tasks" && filter === "completed" && queueFilter === null ? "true" : undefined}
        >
          <CheckCircle2 size={17} className="nav-icon" />
          <span className="nav-text">已完成</span>
          {counts.completed > 0 && <span className="nav-count">{counts.completed}</span>}
        </button>

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
              className="nav-item nav-queue"
              onClick={() => selectQueue(null)}
              aria-current={undefined}
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
