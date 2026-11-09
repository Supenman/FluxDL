import { useMemo } from "react";
import { useStore, sortTasks, taskMatchesFilter } from "../store";
import type { TaskStatus } from "../lib/types";
import { TaskRow } from "./TaskRow";
import { EmptyState } from "./EmptyState";

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
  const select = useStore((s) => s.select);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = tasks.filter((task) => {
      if (!taskMatchesFilter(task, filter)) return false;
      if (!q) return true;
      return (
        task.filename.toLowerCase().includes(q) ||
        task.url.toLowerCase().includes(q) ||
        task.domain.toLowerCase().includes(q)
      );
    });
    return sortTasks(matched, sort);
  }, [tasks, filter, query, sort]);

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

  const grouped = sort === "recent" && !query.trim();
  if (!grouped) {
    return (
      <div className="task-list">
        {filtered.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            selected={selectedId === task.id}
            onSelect={() => select(selectedId === task.id ? null : task.id)}
          />
        ))}
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
                selected={selectedId === task.id}
                onSelect={() => select(selectedId === task.id ? null : task.id)}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}
