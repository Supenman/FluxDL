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
  Maximize2,
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
  compact?: boolean;
}

export function TaskRow({ task, selected, onSelect, compact = false }: TaskRowProps) {
  const select = useStore((s) => s.select);
  const pushToast = useStore((s) => s.pushToast);
  const setProgressId = useStore((s) => s.setProgressId);
  const [busy, setBusy] = useState(false);

  const style = fileStyle(task);
  const pct = percent(task);
  const isActive = task.status === "downloading" || task.status === "connecting";
  const isMedia = task.kind === "media";
  const done = task.status === "completed";
  const failed = task.status === "failed";
  const paused = task.status === "paused";
  const pending = task.pendingApproval === true;

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
      pushToast(pending ? "已拒绝该下载" : "已移出列表，本地文件仍保留", "info");
    });
  };

  const approve = () => {
    void run(async () => {
      await backend.approve(task.id);
      pushToast("已允许，开始下载", "success");
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
      aria-label={`${task.filename}，${pct > 0 ? Math.floor(pct) + "%" : task.status}，${formatSpeed(task.speedBps)}`}
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
          <StatusBadge status={task.status} scheduledAt={task.scheduledAt} pendingApproval={pending} />
        </div>

        <div className="task-sub">
          <Globe size={11} />
          <span className="task-domain">{task.domain || "本地"}</span>
          {isMedia && <span className="task-tag">视频</span>}
          {task.speedLimit && (
            <span className="task-tag subtle">限速 {formatSpeed(task.speedLimit)}</span>
          )}
        </div>

        <div
          className={cx(
            "progress-track",
            isActive && "live",
            done && "done",
            failed && "error",
            task.segments.length > 1 && task.totalBytes > 0 && "has-segments",
          )}
          role="progressbar"
          aria-label={`${task.filename} 下载进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(pct)}
          aria-valuetext={`${Math.floor(pct)}%，${formatSpeed(task.speedBps)}`}
        >
          <div
            className={cx("progress-fill", !task.totalBytes && "indeterminate")}
            style={pct > 0 ? { width: `${pct}%` } : undefined}
          />
          {/* 分段视图：每段一个块，按自身已下载字节填充；多连接时直观看到各段进度（借鉴 MDM 分段条思路，原创实现） */}
          {task.segments.length > 1 &&
            task.totalBytes > 0 &&
            task.segments.map((seg) => {
              const left = (seg.start / task.totalBytes) * 100;
              const width = ((seg.end - seg.start) / task.totalBytes) * 100;
              const segPct = seg.end > seg.start ? (seg.downloaded / (seg.end - seg.start)) * 100 : 0;
              return (
                <span
                  key={seg.index}
                  className={cx("seg-block", seg.done && "is-done")}
                  style={{ insetInlineStart: `${left}%`, width: `${width}%` }}
                  title={`段 ${seg.index + 1} · ${Math.floor(segPct)}%`}
                >
                  <span className="seg-fill" style={{ width: `${segPct}%` }} />
                </span>
              );
            })}
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
          {pending && (
            <>
              <span className="meta-strong">等待你的允许</span>
              <span className="meta-dot" />
              <span>允许后才开始下载</span>
            </>
          )}
          {task.status === "queued" && <span>等待空闲下载槽位…</span>}
          {task.status === "connecting" && <span>正在探测服务器与文件大小…</span>}
          {task.status === "paused" && task.scheduledAt != null && task.scheduledAt > 0 && (
            <span>
              <Clock size={11} /> 计划 {formatDate(task.scheduledAt)} 开始
            </span>
          )}
        </div>

        {/* 紧凑多列视图：补充添加时间 / 来源 / 平均速度（复用已有字段） */}
        {compact && (
          <div className="task-compact-cols">
            <span className="compact-col" title="添加时间">
              <Clock size={10} /> {formatDate(task.createdAt)}
            </span>
            <span className="compact-col" title="来源域名">
              <Globe size={10} /> {task.domain || "本地"}
            </span>
            <span className="compact-col" title="平均速度">
              <Zap size={10} />
              {task.totalBytes > 0 && task.finishedAt
                ? formatSpeed(task.totalBytes / Math.max(1, (task.finishedAt - task.createdAt) / 1000))
                : formatSpeed(task.speedBps)}
            </span>
            <span className="compact-col" title="连接数">
              {task.connections || "自动"} 线程
            </span>
          </div>
        )}
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
          <button
            className="row-button"
            onClick={(e) => {
              e.stopPropagation();
              setProgressId(task.id);
            }}
            title="打开独立进度窗口"
            aria-label="打开独立进度窗口"
          >
            <Maximize2 size={14} />
          </button>
          {pending ? (
            <button
              className="row-button approve"
              onClick={(e) => {
                e.stopPropagation();
                approve();
              }}
              title="允许下载"
              aria-label="允许下载"
            >
              <Check size={16} />
            </button>
          ) : done ? (
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
          <button
            className="row-button danger"
            onClick={(e) => {
              e.stopPropagation();
              remove();
            }}
            title={pending ? "拒绝该下载" : "移出列表（保留文件）"}
            aria-label={pending ? "拒绝下载" : "移出列表"}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
