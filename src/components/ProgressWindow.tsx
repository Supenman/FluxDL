import { useEffect } from "react";
import { X, Zap, Clock, Activity, Cpu } from "lucide-react";
import { useStore } from "../store";
import { formatBytes, formatEta, formatSpeed, percent } from "../lib/format";
import { SpeedChart } from "./SpeedChart";

const EMPTY_LOGS: never[] = [];

/** 独立进度窗口：借鉴 MDM 每任务独立进度窗口的信息组织，用本仓组件原创实现。 */
export function ProgressWindow() {
  const progressId = useStore((s) => s.progressId);
  const setProgressId = useStore((s) => s.setProgressId);
  const tasks = useStore((s) => s.tasks);
  const logMap = useStore((s) => s.logs);
  const task = progressId ? tasks.find((t) => t.id === progressId) ?? null : null;
  const logs = progressId ? logMap[progressId] ?? EMPTY_LOGS : EMPTY_LOGS;

  useEffect(() => {
    if (!progressId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setProgressId(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [progressId, setProgressId]);

  if (!progressId || !task) return null;

  const pct = percent(task);
  const isActive = task.status === "downloading" || task.status === "connecting";
  const segs = task.segments;

  return (
    <div className="progress-window-backdrop" onClick={() => setProgressId(null)}>
      <div className="progress-window" role="dialog" aria-label={`进度：${task.filename}`} onClick={(e) => e.stopPropagation()}>
        <header className="pw-head">
          <div className="pw-title">
            <span className="pw-eyebrow">下载进度</span>
            <h3 title={task.filename}>{task.filename}</h3>
          </div>
          <button className="pw-close" onClick={() => setProgressId(null)} aria-label="关闭进度窗口">
            <X size={16} />
          </button>
        </header>

        <div className="pw-body">
          <div className="pw-pct-row">
            <span className="pw-pct">{task.totalBytes ? `${Math.floor(pct)}%` : "—"}</span>
            <span className="pw-bytes">
              {formatBytes(task.downloadedBytes)} / {task.totalBytes ? formatBytes(task.totalBytes) : "大小未知"}
            </span>
          </div>

          <div className={`pw-bar ${isActive ? "live" : ""}`}>
            <div className="pw-bar-fill" style={{ width: `${pct}%` }} />
            {segs.length > 1 && task.totalBytes > 0 && segs.map((seg) => {
              const left = (seg.start / task.totalBytes) * 100;
              const width = ((seg.end - seg.start) / task.totalBytes) * 100;
              const sp = seg.end > seg.start ? (seg.downloaded / (seg.end - seg.start)) * 100 : 0;
              return (
                <span key={seg.index} className="pw-seg" style={{ left: `${left}%`, width: `${width}%` }} title={`段 ${seg.index + 1} · ${Math.floor(sp)}%`}>
                  <span className="pw-seg-fill" style={{ width: `${sp}%` }} />
                </span>
              );
            })}
          </div>

          <div className="pw-stats">
            <div className="pw-stat"><Zap size={13} /><span>速度</span><strong>{formatSpeed(task.speedBps)}</strong></div>
            <div className="pw-stat"><Clock size={13} /><span>剩余</span><strong>{formatEta(task.etaSeconds)}</strong></div>
            <div className="pw-stat"><Cpu size={13} /><span>连接</span><strong>{task.connections || "自动"}</strong></div>
            <div className="pw-stat"><Activity size={13} /><span>分段</span><strong>{segs.length || "—"}</strong></div>
          </div>

          <div className="pw-chart">
            <div className="pw-subtitle">实时速度</div>
            <SpeedChart taskId={task.id} speedBps={task.speedBps} active={isActive} />
          </div>

          <div className="pw-logs">
            <div className="pw-subtitle">事件日志</div>
            <div className="pw-log-list">
              {logs.length === 0 ? (
                <div className="pw-log-empty">暂无日志</div>
              ) : (
                logs.slice(-30).reverse().map((line, i) => (
                  <div className="pw-log-line" key={`${line.at}-${i}`}>
                    <span className="pw-log-time">{new Date(line.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                    <span className="pw-log-msg">{line.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
