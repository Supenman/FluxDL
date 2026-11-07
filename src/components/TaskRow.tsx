import { useState } from "react";
import {
  Pause,
  Play,
  FolderOpen,
  Trash2,
  Zap,
  Clock,
  Globe,
  RefreshCw,
  AlertTriangle,
  Check,
  Film,
} from "lucide-react";
import type { Task } from "../lib/types";
import { backend } from "../lib/backend";
import { useStore } from "../store";
import {
  cx,
  fileStyle,
  formatBytes,
  formatDate,
  formatEta,
  formatSpeed,
  percent,
} from "../lib/format";
import { StatusBadge } from "./StatusBadge";

interface TaskRowProps {
  task: Task;
  selected: boolean;
  onSelect: () => void;
}

export function TaskRow({ task, selected, onSelect }: TaskRowProps) {
  const select = useStore((s) => s.select);
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  const style = fileStyle(task);
  const pct = percent(task);
  const isActive = task.status === "downloading" || task.status === "connecting";
  const isMedia = task.kind === "media";
  const done = task.status === "completed";
  const failed = task.status === "failed";
  const paused = task.status === "paused";

  const run = async (action: () => Promise<void>, success?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      if (success) pushToast(success, "success");
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => {
    if (isActive) {
      void run(() => backend.pause(task.id), "已暂停");
    } else if (paused || failed) {
      void run(
        () => (failed ? backend.retry(task.id) : backend.resume(task.id)),
        failed ? "正在重试" : "已继续下载",
      );
    }
  };

  const remove = () => {
    void run(async () => {
      await backend.remove(task.id, false);
      if (selected) select(null);
      pushToast("已移出列表，本地文件仍保留", "info");
    });
  };

  const openFolder = () => {
    void run(() => backend.openPath(task.savePath));
  };

  return (
    <div
      className={cx(
        "task-row",
        selected && "is-selected",
        isActive && "is-active",
        failed && "is-failed",
      )}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className={`file-tile tone-${style.tone}`}>
        <span className="file-ext">{style.label || "FILE"}</span>
        {isMedia && <Film size={9} className="file-kind" />}
      </div>

      <div className="task-main">
        <div className="task-top">
          <span className="task-name" title={task.filename}>
            {task.filename}
          </span>
          <StatusBadge status={task.status} />
        </div>

        <div className="task-sub">
          <Globe size={11} />
          <span className="task-domain">{task.domain || "本地"}</span>
          {isMedia && <span className="task-tag">视频</span>}
          {task.speedLimit && (
            <span className="task-tag subtle">限速 {formatSpeed(task.speedLimit)}</span>
          )}
        </div>

        <div className={cx("progress-track", isActive && "live", done && "done", failed && "error")}>
          <div
            className={cx("progress-fill", !task.totalBytes && "indeterminate")}
            style={pct > 0 ? { width: `${pct}%` } : undefined}
          />
          {task.segments.length > 1 &&
            task.totalBytes > 0 &&
            task.segments.slice(1).map((seg) => (
              <span
                key={seg.index}
                className="segment-tick"
                style={{ left: `${(seg.start / task.totalBytes) * 100}%` }}
              />
            ))}
        </div>

        <div className="task-meta">
          {isActive && (
            <>
              <span className="meta-strong">
                <Zap size={11} />
                {formatSpeed(task.speedBps)}
              </span>
              <span className="meta-dot" />
              <span>
                <Clock size={11} /> 剩余 {formatEta(task.etaSeconds)}
              </span>
              <span className="meta-dot" />
              <span>{task.connections} 线程</span>
            </>
          )}
          {paused && (
            <>
              <span className="meta-strong">{formatBytes(task.downloadedBytes)} 已下载</span>
              <span className="meta-dot" />
              <span>点击继续，断点续传</span>
            </>
          )}
          {done && (
            <>
              <span className="meta-strong">{formatBytes(task.totalBytes)}</span>
              <span className="meta-dot" />
              <span>{task.finishedAt ? formatDate(task.finishedAt) : "刚刚完成"}</span>
              {isMedia && (
                <>
                  <span className="meta-dot" />
                  <span>视频</span>
                </>
              )}
            </>
          )}
          {failed && (
            <>
              <span className="meta-error">
                <AlertTriangle size={11} />
                {task.error ?? "下载失败"}
              </span>
            </>
          )}
          {task.status === "queued" && <span>等待空闲下载槽位…</span>}
          {task.status === "connecting" && <span>正在探测服务器与文件大小…</span>}
        </div>
      </div>

      <div className="task-right">
        <div className="task-percent">
          {done ? (
            <span className="complete-mark">
              <Check size={16} />
            </span>
          ) : (
            <span className="percent-value">
              {task.totalBytes ? `${Math.floor(pct)}%` : isActive ? "…" : "—"}
            </span>
          )}
          <span className="percent-sub">
            {task.totalBytes
              ? `${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}`
              : isActive
                ? formatBytes(task.downloadedBytes)
                : "大小未知"}
          </span>
        </div>

        <div className="row-actions">
          {done ? (
            <button
              className="row-button"
              onClick={(e) => {
                e.stopPropagation();
                openFolder();
              }}
              title="打开所在文件夹"
              aria-label="打开所在文件夹"
            >
              <FolderOpen size={15} />
            </button>
          ) : (
            <button
              className="row-button"
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              title={isActive ? "暂停" : failed ? "重试" : "继续"}
              aria-label={isActive ? "暂停" : failed ? "重试" : "继续"}
            >
              {isActive ? <Pause size={15} /> : failed ? <RefreshCw size={14} /> : <Play size={15} />}
            </button>
          )}
          {failed && (
            <button
              className="row-button"
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              title="重试"
              aria-label="重试"
            >
              <RefreshCw size={14} />
            </button>
          )}
          <button
            className="row-button danger"
            onClick={(e) => {
              e.stopPropagation();
              remove();
            }}
            title="移出列表（保留文件）"
            aria-label="移出列表"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
