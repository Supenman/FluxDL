import { useMemo, useEffect } from "react";
import { useStore, sortTasks, taskMatchesFilter } from "../store";
import { queueOfTask } from "../lib/queues";
import type { TaskStatus } from "../lib/types";
import { TaskRow } from "./TaskRow";
import { TaskTable } from "./TaskTable";
import { EmptyState } from "./EmptyState";
import { ContextMenu } from "./ContextMenu";
import { useTaskContextMenu } from "../hooks/useTaskContextMenu";

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
  const { menu, openMenu, close, items } = useTaskContextMenu();

  const menuNode = menu ? (
    <ContextMenu x={menu.x} y={menu.y} items={items} onClose={close} label={`${menu.task.filename} 操作`} />
  ) : null;

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
    return sortTasks(matched, sort);
  }, [tasks, filter, query, sort, queues, queueFilter]);

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

  if (viewMode === "table") {
    return (
      <>
        <TaskTable
          tasks={filtered}
          selectedId={selectedId}
          focusedId={focusedId}
          onSelect={(id) => select(selectedId === id ? null : id)}
          onContextMenu={openMenu}
        />
        {menuNode}
      </>
    );
  }

  const grouped = sort === "recent" && !query.trim();
  if (!grouped) {
    return (
      <div className="task-list">
        {filtered.map((task) => (
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
      {menuNode}
    </div>
  );
}
