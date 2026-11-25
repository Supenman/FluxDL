import { useState } from "react";
import { Trash2, Plus, Layers, Clock, Gauge, RotateCw, Power } from "lucide-react";
import { useStore } from "../store";
import {
  DEFAULT_QUEUE_ID,
  newQueue,
  queueOfTask,
  type Queue,
} from "../lib/queues";
import { cx } from "../lib/format";

/** 队列管理：新增/编辑队列、并发上限、时段、失败重试、启停、任务指派。 */
export function QueueManager() {
  const tasks = useStore((s) => s.tasks);
  const queues = useStore((s) => s.queues);
  const setQueues = useStore((s) => s.setQueues);
  const assignTaskQueue = useStore((s) => s.assignTaskQueue);
  const pushToast = useStore((s) => s.pushToast);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [assignFilter, setAssignFilter] = useState("");

  const update = (id: string, patch: Partial<Queue>) => {
    setQueues({
      ...queues,
      queues: queues.queues.map((q) => (q.id === id ? { ...q, ...patch } : q)),
    });
  };

  const remove = (q: Queue) => {
    if (q.id === DEFAULT_QUEUE_ID) return;
    setQueues({
      ...queues,
      queues: queues.queues.filter((x) => x.id !== q.id),
      assignment: Object.fromEntries(
        Object.entries(queues.assignment).filter(([, v]) => v !== q.id),
      ),
    });
    pushToast(`已删除队列「${q.name}」，任务移回默认队列`, "info");
  };

  const hourLabel = (h: number | null) => (h === null ? "不限" : `${String(h).padStart(2, "0")}:00`);

  return (
    <section className="settings-section">
      <div className="section-head">
        <span className="section-icon"><Layers size={16} /></span>
        <div>
          <h2>队列与调度</h2>
          <p>把任务分到不同队列，分别设定并发数、允许时段与失败重试。</p>
        </div>
      </div>

      <div className="queue-manager">
        {queues.queues.map((q) => {
          const members = tasks.filter((t) => queueOfTask(queues, t.id) === q.id);
          const running = members.filter(
            (t) => t.status === "downloading" || t.status === "connecting" || t.status === "queued",
          ).length;
          const isOpen = expanded === q.id;
          return (
            <div key={q.id} className={cx("queue-card", !q.enabled && "is-disabled")}>
              <div className="queue-card-head" onClick={() => setExpanded(isOpen ? null : q.id)}>
                <span className="queue-dot" style={{ background: q.color }} />
                <div className="queue-card-title">
                  <strong>{q.name}</strong>
                  <span>{members.length} 个任务 · {running} 运行中</span>
                </div>
                <button
                  className={cx("queue-power", q.enabled && "on")}
                  onClick={(e) => { e.stopPropagation(); update(q.id, { enabled: !q.enabled }); }}
                  title={q.enabled ? "停用队列（暂停其任务）" : "启用队列"}
                  aria-label={q.enabled ? "停用队列" : "启用队列"}
                >
                  <Power size={14} />
                </button>
                <button
                  className={cx("queue-expand", isOpen && "open")}
                  aria-label={isOpen ? "收起" : "展开"}
                >▾</button>
              </div>

              {isOpen && (
                <div className="queue-card-body">
                  <label className="queue-field">
                    <span>名称</span>
                    <input
                      value={q.name}
                      onChange={(e) => update(q.id, { name: e.target.value })}
                      disabled={q.id === DEFAULT_QUEUE_ID}
                      maxLength={40}
                    />
                  </label>
                  <label className="queue-field">
                    <span><Gauge size={12} /> 并发上限（0 = 跟随全局）</span>
                    <input
                      type="number"
                      min={0}
                      max={64}
                      value={q.maxActive}
                      onChange={(e) => update(q.id, { maxActive: Math.max(0, Math.min(64, Number(e.target.value) || 0)) })}
                    />
                  </label>
                  <div className="queue-field">
                    <span><Clock size={12} /> 允许时段（本地时间）</span>
                    <div className="queue-hours">
                      <select
                        value={q.startHour ?? ""}
                        onChange={(e) => update(q.id, { startHour: e.target.value === "" ? null : Number(e.target.value) })}
                        aria-label="开始时间"
                      >
                        <option value="">不限</option>
                        {Array.from({ length: 24 }, (_, h) => (
                          <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                        ))}
                      </select>
                      <span className="queue-hours-sep">至</span>
                      <select
                        value={q.endHour ?? ""}
                        onChange={(e) => update(q.id, { endHour: e.target.value === "" ? null : Number(e.target.value) })}
                        aria-label="结束时间"
                      >
                        <option value="">不限</option>
                        {Array.from({ length: 24 }, (_, h) => (
                          <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                        ))}
                      </select>
                      <span className="queue-hours-hint">
                        {q.startHour !== null && q.endHour !== null
                          ? q.startHour > q.endHour
                            ? "跨零点"
                            : `${hourLabel(q.startHour)}–${hourLabel(q.endHour)}`
                          : "全天"}
                      </span>
                    </div>
                  </div>
                  <label className="queue-field">
                    <span><RotateCw size={12} /> 失败自动重试次数（0 = 不重试）</span>
                    <input
                      type="number"
                      min={0}
                      max={20}
                      value={q.retryOnFail}
                      onChange={(e) => update(q.id, { retryOnFail: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })}
                    />
                  </label>

                  <div className="queue-assign">
                    <span className="queue-assign-label">分配任务到此队列</span>
                    <input
                      value={assignFilter}
                      onChange={(e) => setAssignFilter(e.target.value)}
                      placeholder="搜索任务名筛选"
                      className="queue-assign-search"
                    />
                    <div className="queue-task-list">
                      {tasks
                        .filter((t) => !assignFilter || t.filename.toLowerCase().includes(assignFilter.toLowerCase()))
                        .slice(0, 40)
                        .map((t) => (
                          <button
                            key={t.id}
                            className={cx("queue-task-row", queueOfTask(queues, t.id) === q.id && "assigned")}
                            onClick={() => assignTaskQueue(t.id, q.id)}
                            title={t.filename}
                          >
                            <span className="queue-task-check">{queueOfTask(queues, t.id) === q.id ? "✓" : ""}</span>
                            <span className="queue-task-name">{t.filename}</span>
                          </button>
                        ))}
                      {tasks.length === 0 && <span className="queue-task-empty">暂无任务</span>}
                    </div>
                  </div>

                  {q.id !== DEFAULT_QUEUE_ID && (
                    <button className="queue-delete" onClick={() => remove(q)}>
                      <Trash2 size={13} /> 删除队列
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <button
          className="queue-new"
          onClick={() => {
            const q = newQueue(`队列 ${queues.queues.length}`, queues.queues);
            setQueues({ ...queues, queues: [...queues.queues, q] });
            setExpanded(q.id);
          }}
        >
          <Plus size={14} /> 新建队列
        </button>
      </div>
    </section>
  );
}
