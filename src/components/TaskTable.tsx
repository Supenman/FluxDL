import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Columns3,
  Filter,
  Globe,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type { FileCategory, Task } from "../lib/types";
import { backend } from "../lib/backend";
import { fileCategory, useStore } from "../store";
import {
  cx,
  fileStyle,
  formatBytes,
  formatDate,
  formatEta,
  formatSpeed,
  percent,
} from "../lib/format";
import {
  COLUMN_DEFS,
  defaultColumnsConfig,
  filterByColumns,
  readColumnsConfig,
  saveColumnsConfig,
  visibleColumns,
  type ColumnDef,
  type ColumnKey,
  type ColumnsConfig,
} from "../lib/columns";
import { StatusBadge } from "./StatusBadge";
import { dispatchHoverShow, dispatchHoverMove, dispatchHoverHide } from "./TaskHoverPreview";

const CATEGORY_LABEL: Record<FileCategory, string> = {
  video: "视频",
  document: "文档",
  archive: "压缩包",
  other: "其他",
};

interface TaskTableProps {
  tasks: Task[];
  selectedId: string | null;
  focusedId?: string | null;
  onSelect: (id: string) => void;
  onContextMenu?: (event: React.MouseEvent, task: Task) => void;
  /** 拖拽排序：由 useDragReorder 摊到每个 tr 上 */
  rowProps?: (id: string) => import("../hooks/useDragReorder").DragRowProps;
  dragOverId?: string | null;
  draggingId?: string | null;
}

/** MDM 式多列数据表：列可显隐/排序/调宽/重排/过滤，配置持久化。原创实现。 */
export function TaskTable({
  tasks,
  selectedId,
  focusedId = null,
  onSelect,
  onContextMenu,
  rowProps,
  dragOverId = null,
  draggingId = null,
}: TaskTableProps) {
  const sort = useStore((s) => s.sort);
  const setSort = useStore((s) => s.setSort);
  const pushToast = useStore((s) => s.pushToast);

  const [cfg, setCfg] = useState<ColumnsConfig>(() => readColumnsConfig());
  const [menuOpen, setMenuOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [dragKey, setDragKey] = useState<ColumnKey | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const commit = (next: ColumnsConfig) => {
    setCfg(next);
    saveColumnsConfig(next);
  };

  // 点击外部关闭列菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const cols = useMemo(() => visibleColumns(cfg), [cfg]);
  const rows = useMemo(
    () => filterByColumns(tasks, cfg, (t) => CATEGORY_LABEL[fileCategory(t)]),
    [tasks, cfg],
  );
  const minTableWidth = cols.reduce((sum, c) => sum + cfg.states[c.key].width, 0) + 44;

  const headerClick = (col: ColumnDef) => {
    if (!col.sort) return;
    setSort(col.sort);
  };

  // 拖动表头重排列顺序（文件名列固定在最前，不参与拖动）
  const onDropColumn = (target: ColumnKey) => {
    if (!dragKey || dragKey === target || dragKey === "name") return;
    const order = cfg.order.filter((k) => k !== dragKey);
    const at = order.indexOf(target);
    order.splice(at < 0 ? order.length : at, 0, dragKey);
    commit({ ...cfg, order });
    setDragKey(null);
  };

  // 拖动列边界调宽
  const startResize = (e: React.PointerEvent, col: ColumnDef) => {
    e.preventDefault();
    e.stopPropagation();
    const def = COLUMN_DEFS.find((d) => d.key === col.key)!;
    const startX = e.clientX;
    const startW = cfg.states[col.key].width;
    let latest = startW;
    const move = (ev: PointerEvent) => {
      latest = Math.min(480, Math.max(def.minWidth, startW + (ev.clientX - startX)));
      setCfg((prev) => ({
        ...prev,
        states: { ...prev.states, [col.key]: { ...prev.states[col.key], width: latest } },
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      commit({
        ...cfg,
        states: { ...cfg.states, [col.key]: { ...cfg.states[col.key], width: latest } },
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleColumn = (key: ColumnKey) => {
    const def = COLUMN_DEFS.find((d) => d.key === key)!;
    if (!def.lockable) return;
    const cur = cfg.states[key];
    commit({
      ...cfg,
      states: { ...cfg.states, [key]: { ...cur, visible: !cur.visible } },
    });
  };

  const setFilter = (key: ColumnKey, value: string) => {
    commit({ ...cfg, filters: { ...cfg.filters, [key]: value } });
  };

  const resetColumns = () => {
    commit(defaultColumnsConfig());
    pushToast("已恢复默认列布局", "info");
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

  const activeFilterCount = Object.values(cfg.filters).filter((v) => v && v.trim()).length;
  // 有筛选值时强制展开筛选行，避免用户看不到自己已设的筛选条件而无法调整。
  const filtersVisible = showFilters || activeFilterCount > 0;
  // 切换视图时收起筛选行，回到清爽的默认态。
  const toggleFilters = () => setShowFilters((v) => !v);

  return (
    <div className="task-table-shell">
      <div className="table-toolbar">
        <div className="table-toolbar-hint">
          多列视图 · {rows.length} 项
          {activeFilterCount > 0 && <span className="table-filter-badge">过滤 {activeFilterCount}</span>}
        </div>
        <div className="table-toolbar-tools">
          <button
            className={cx("table-tool-button", filtersVisible && "active")}
            onClick={toggleFilters}
            aria-expanded={filtersVisible}
            title={filtersVisible ? "隐藏列筛选框" : "显示列筛选框"}
          >
            <Filter size={13} />
            筛选
          </button>
          <div className="table-column-menu-wrap" ref={menuRef}>
          <button
            className={cx("table-tool-button", menuOpen && "active")}
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            title="自定义列"
          >
            <Columns3 size={13} />
            列
            <ChevronDown size={11} />
          </button>
          {menuOpen && (
            <div className="table-column-menu" role="menu">
              <div className="tcm-head">
                <span>显示的列</span>
                <button className="tcm-reset" onClick={resetColumns} title="恢复默认">
                  <RotateCcw size={12} /> 默认
                </button>
              </div>
              {COLUMN_DEFS.map((def) => {
                const active = cfg.states[def.key]?.visible ?? def.defaultVisible;
                return (
                  <button
                    key={def.key}
                    className="tcm-item"
                    role="menuitemcheckbox"
                    aria-checked={active}
                    disabled={!def.lockable}
                    onClick={() => toggleColumn(def.key)}
                  >
                    <span className={cx("tcm-check", active && "on")}>
                      {active && <Check size={11} />}
                    </span>
                    <span>{def.label}</span>
                    {!def.lockable && <span className="tcm-lock">固定</span>}
                  </button>
                );
              })}
              {activeFilterCount > 0 && (
                <button
                  className="tcm-clear-filter"
                  onClick={() => commit({ ...cfg, filters: {} })}
                >
                  清除全部过滤
                </button>
              )}
            </div>
          )}
          </div>
        </div>
      </div>

      <div className="task-table-wrap">
        <table className="task-table" style={{ minWidth: minTableWidth }}>
          <colgroup>
            {cols.map((c) => (
              <col key={c.key} style={{ width: cfg.states[c.key].width }} />
            ))}
            <col style={{ width: 44 }} />
          </colgroup>
          <thead>
            <tr>
              {cols.map((col) => {
                const sorted = sort === col.sort;
                const filterVal = cfg.filters[col.key] ?? "";
                return (
                  <th
                    key={col.key}
                    className={cx(
                      col.sort && "sortable",
                      sorted && "sorted",
                      col.align === "right" && "align-right",
                      dragKey === col.key && "dragging",
                      filtersVisible && "has-filters",
                    )}
                    onClick={() => headerClick(col)}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && col.sort) {
                        e.preventDefault();
                        headerClick(col);
                      }
                    }}
                    tabIndex={col.sort ? 0 : undefined}
                    role="columnheader"
                    aria-sort={sorted ? (sort === "recent" ? "none" : "descending") : "none"}
                    draggable={col.key !== "name"}
                    onDragStart={() => setDragKey(col.key)}
                    onDragOver={(e) => { if (dragKey) e.preventDefault(); }}
                    onDrop={() => onDropColumn(col.key)}
                    onDragEnd={() => setDragKey(null)}
                    title={col.sort ? `按${col.label}排序 · 可拖动调整列序` : undefined}
                  >
                    <span className="th-label">
                      {col.label}
                      {sorted && <span className="sort-arrow">▾</span>}
                      {filterVal && <span className="th-filter-dot" title="此列有筛选" />}
                    </span>
                    {filtersVisible && (
                      <input
                        className="th-filter"
                        value={filterVal}
                        onChange={(e) => setFilter(col.key, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        placeholder="筛选"
                        aria-label={`按${col.label}筛选`}
                      />
                    )}
                    <span
                      className="col-resizer"
                      role="separator"
                      aria-orientation="vertical"
                      onPointerDown={(e) => startResize(e, col)}
                      onClick={(e) => e.stopPropagation()}
                      title="拖动调整列宽"
                    />
                  </th>
                );
              })}
              <th className="col-actions" aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map((task) => {
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
                    focusedId === task.id && "is-focused",
                    done && "is-done",
                    dragOverId === task.id && "is-drag-over",
                    draggingId === task.id && "is-dragging",
                  )}
                  onClick={() => onSelect(task.id)}
                  onMouseDown={() => useStore.getState().setFocus(task.id)}
                  onMouseEnter={(e) => dispatchHoverShow(task.id, e.clientX, e.clientY)}
                  onMouseMove={(e) => dispatchHoverMove(e.clientX, e.clientY)}
                  onMouseLeave={() => dispatchHoverHide()}
                  onContextMenu={onContextMenu ? (event) => onContextMenu(event, task) : undefined}
                  {...(rowProps ? rowProps(task.id) : {})}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      useStore.getState().setFocus(task.id);
                      onSelect(task.id);
                    }
                  }}
                >
                  {cols.map((col) => (
                    <td
                      key={col.key}
                      className={cx(
                        `c-${col.key}`,
                        col.align === "right" && "num",
                        col.key === "rate" && active && "live",
                      )}
                    >
                      {renderCell(task, col.key, pct, active, tone)}
                    </td>
                  ))}
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
        {rows.length === 0 && (
          <div className="table-empty">没有符合列过滤条件的任务</div>
        )}
      </div>
    </div>
  );
}

function renderCell(
  task: Task,
  key: ColumnKey,
  pct: number,
  active: boolean,
  tone: { label: string; tone: string },
) {
  switch (key) {
    case "name":
      return (
        <>
          <span className={`table-file-tile tone-${tone.tone}`}>
            {tone.label || "FILE"}
          </span>
          <span className="c-name-text">
            <span className="c-name-line" title={task.filename}>{task.filename}</span>
            <span className="table-mini-track" aria-hidden="true">
              <span className="table-mini-fill" style={{ width: `${pct}%` }} />
            </span>
          </span>
        </>
      );
    case "status":
      return (
        <StatusBadge
          status={task.status}
          scheduledAt={task.scheduledAt}
          pendingApproval={task.pendingApproval}
        />
      );
    case "size":
      return task.totalBytes ? formatBytes(task.totalBytes) : "—";
    case "progress":
      return (
        <span
          className="c-progress"
          role="progressbar"
          aria-label={`${task.filename} 下载进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={task.totalBytes ? Math.floor(pct) : 0}
          aria-valuetext={task.totalBytes ? `${Math.floor(pct)}%` : "大小未知"}
        >
          <span className="table-progress" aria-hidden="true">
            <span className="table-progress-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="table-progress-pct num" aria-hidden="true">
            {task.totalBytes ? `${Math.floor(pct)}%` : "—"}
          </span>
        </span>
      );
    case "eta":
      return (
        <span title={active && task.etaSeconds != null ? formatEta(task.etaSeconds) : undefined}>
          {active ? (task.etaSeconds != null ? formatEta(task.etaSeconds) : "计算中") : "—"}
        </span>
      );
    case "rate":
      return active ? formatSpeed(task.speedBps) : "—";
    case "added":
      return formatDate(task.createdAt);
    case "domain":
      return (
        <span className="c-domain" title={task.domain || ""}>
          <Globe size={11} />
          <span>{task.domain || "本地"}</span>
        </span>
      );
    case "category":
      return CATEGORY_LABEL[fileCategory(task)];
    case "connections":
      return active ? String(task.connections) : "—";
    case "speedLimit":
      return task.speedLimit ? formatSpeed(task.speedLimit) : "—";
    default:
      return "";
  }
}
