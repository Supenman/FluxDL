import { useMemo, useEffect, useState, useRef, useCallback } from "react";
import { useStore, sortTasks, taskMatchesFilter } from "../store";
import { queueOfTask } from "../lib/queues";
import type { TaskStatus } from "../lib/types";
import { TaskRow } from "./TaskRow";
import { TaskTable } from "./TaskTable";
import { EmptyState } from "./EmptyState";
import { ContextMenu } from "./ContextMenu";
import { BatchActionBar } from "./BatchActionBar";
import { useTaskContextMenu } from "../hooks/useTaskContextMenu";
import { useDragReorder } from "../hooks/useDragReorder";

const GROUPS: Array<{ label: string; statuses: TaskStatus[] }> = [
  { label: "进行中", statuses: ["downloading", "connecting", "queued"] },
  { label: "已暂停", statuses: ["paused"] },
  { label: "失败了", statuses: ["failed"] },
  { label: "已完成", statuses: ["completed"] },
];

export function TaskList() {
  const tasks = useStore((s) => s.tasks);
  const filter = useStore((s) => s.filter);
  const query = useStore((s) => s.query);
  const sort = useStore((s) => s.sort);
  const selectedId = useStore((s) => s.selectedId);
  const focusedId = useStore((s) => s.focusedId);
  const select = useStore((s) => s.select);
  const compact = useStore((s) => s.compact);
  const viewMode = useStore((s) => s.viewMode);
  const queues = useStore((s) => s.queues);
  const queueFilter = useStore((s) => s.queueFilter);
  const manualOrder = useStore((s) => s.manualOrder);
  const { menu, openMenu, close, items } = useTaskContextMenu();

  const menuNode = menu ? (
    <ContextMenu x={menu.x} y={menu.y} items={items} onClose={close} label={`${menu.task.filename} 操作`} />
  ) : null;

  const [multiSelected, setMultiSelected] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = tasks.filter((task) => {
      if (queueFilter && queueOfTask(queues, task.id) !== queueFilter) return false;
      if (!taskMatchesFilter(task, filter)) return false;
      if (!q) return true;
      return (
        task.filename.toLowerCase().includes(q) ||
        task.url.toLowerCase().includes(q) ||
        task.domain.toLowerCase().includes(q)
      );
    });
    return sortTasks(matched, sort, manualOrder);
  }, [tasks, filter, query, sort, manualOrder, queues, queueFilter]);

  // 剔除已不存在或被筛选隐藏的多选 ID
  const visibleMultiIds = useMemo(() => {
    if (multiSelected.size === 0) return [] as string[];
    const visible = new Set(filtered.map((t) => t.id));
    return [...multiSelected].filter((id) => visible.has(id));
  }, [multiSelected, filtered]);

  const clearMulti = useCallback(() => {
    setMultiSelected(new Set());
  }, []);

  const selectAllVisible = useCallback(() => {
    setMultiSelected(new Set(filtered.map((t) => t.id)));
  }, [filtered]);

  const handleRowSelect = useCallback(
    (id: string, event?: React.MouseEvent) => {
      const isCtrl = Boolean(event && (event.ctrlKey || event.metaKey));
      const isShift = Boolean(event && event.shiftKey);

      if (isShift) {
        const ids = filtered.map((t) => t.id);
        const anchor = anchorRef.current ?? focusedId ?? selectedId ?? id;
        const from = ids.indexOf(anchor);
        const to = ids.indexOf(id);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from <= to ? [from, to] : [to, from];
          setMultiSelected(new Set(ids.slice(lo, hi + 1)));
          return;
        }
      }

      if (isCtrl) {
        setMultiSelected((prev) => {
          const next = new Set(prev);
          if (next.size === 0 && selectedId && selectedId !== id) {
            next.add(selectedId);
          }
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        anchorRef.current = id;
        return;
      }

      if (multiSelected.size > 0) {
        setMultiSelected(new Set());
      }
      anchorRef.current = id;
      select(selectedId === id ? null : id);
    },
    [filtered, focusedId, selectedId, multiSelected.size, select],
  );

  // 拖拽重排：把当前可见顺序里的两个 id 换位，写入持久化顺序并切到手动排序。
  // 只有「按状态分组」的视图（recent 且无搜索）不接受拖拽——分组由状态决定，手动排序无意义。
  const grouped = sort === "recent" && !query.trim();
  const canDrag = !grouped;
  const onReorder = (dragId: string, overId: string) => {
    if (dragId === overId) return;
    const ids = filtered.map((t) => t.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    useStore.getState().reorderTasks(ids);
  };
  const { rowProps, dragOverId, draggingId } = useDragReorder({ enabled: canDrag, onReorder });

  // 键盘导航：↑/↓ 只在筛选结果中移动「焦点行」，按 Enter 才打开详情抽屉。
  // 焦点与选中分离后，浏览列表不会不停弹抽屉遮盖内容，也符合 IDM/资源管理器的直觉。
  // 输入框聚焦、命令面板、新建弹窗、右键菜单打开时不接管，避免与打字冲突。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const state = useStore.getState();
      if (state.commandOpen || state.newTaskOpen) return;
      if (document.querySelector(".context-menu")) return;
      const nav = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (nav.includes(e.key)) {
        const ids = filtered.map((t) => t.id);
        if (ids.length === 0) return;
        e.preventDefault();
        const cur = state.focusedId ?? state.selectedId;
        const at = cur ? ids.indexOf(cur) : -1;
        let next = at;
        if (e.key === "Home") next = 0;
        else if (e.key === "End") next = ids.length - 1;
        else if (e.key === "ArrowDown") next = at < 0 ? 0 : Math.min(ids.length - 1, at + 1);
        else next = at < 0 ? ids.length - 1 : Math.max(0, at - 1);
        state.setFocus(ids[next]);
        window.requestAnimationFrame(() => {
          document
            .querySelector(".is-focused")
            ?.scrollIntoView({ block: "nearest" });
        });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (filtered.length > 0) {
          e.preventDefault();
          setMultiSelected(new Set(filtered.map((t) => t.id)));
        }
        return;
      }
      if (e.key === "Escape") {
        setMultiSelected((prev) => (prev.size > 0 ? new Set() : prev));
        return;
      }
      if (e.key === "Enter") {
        const id = state.focusedId;
        if (!id) return;
        e.preventDefault();
        state.select(state.selectedId === id ? null : id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered]);

  if (tasks.length === 0) {
    return <EmptyState mode="empty" />;
  }

  if (filtered.length === 0) {
    return query.trim() ? (
      <EmptyState mode="search" query={query.trim()} />
    ) : (
      <EmptyState mode="filter" />
    );
  }

  const batchBar = (
    <BatchActionBar
      selectedIds={visibleMultiIds}
      totalCount={filtered.length}
      onSelectAll={selectAllVisible}
      onClear={clearMulti}
    />
  );

  if (viewMode === "table") {
    return (
      <>
        <TaskTable
          tasks={filtered}
          selectedId={selectedId}
          multiSelected={multiSelected}
          focusedId={focusedId}
          onSelect={handleRowSelect}
          onContextMenu={openMenu}
          rowProps={rowProps}
          dragOverId={dragOverId}
          draggingId={draggingId}
        />
        {batchBar}
        {menuNode}
      </>
    );
  }

  if (!grouped) {
    return (
      <div className="task-list">
        {filtered.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            compact={compact}
            selected={selectedId === task.id}
            multiSelected={multiSelected.has(task.id)}
            focused={focusedId === task.id}
            onSelect={(event) => handleRowSelect(task.id, event)}
            onContextMenu={openMenu}
            {...rowProps(task.id)}
            isDragOver={dragOverId === task.id}
            isDragging={draggingId === task.id}
          />
        ))}
        {batchBar}
        {menuNode}
      </div>
    );
  }

  return (
    <div className="task-list grouped">
      {GROUPS.map((group) => {
        const items = filtered.filter((task) => group.statuses.includes(task.status));
        if (items.length === 0) return null;
        return (
          <section className="task-group" key={group.label}>
            <div className="group-head">
              <span className="group-label">{group.label}</span>
              <span className="group-count">{items.length}</span>
              <span className="group-rule" />
            </div>
            {items.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                compact={compact}
                selected={selectedId === task.id}
                focused={focusedId === task.id}
                onSelect={() => select(selectedId === task.id ? null : task.id)}
                onContextMenu={openMenu}
              />
            ))}
          </section>
        );
      })}
      {batchBar}
      {menuNode}
    </div>
  );
}
