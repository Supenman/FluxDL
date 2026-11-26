import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  X,
  Pause,
  Play,
  RefreshCw,
  FolderOpen,
  Copy,
  Trash2,
  Zap,
  Clock,
  Layers,
  Gauge,
  Globe,
  Calendar,
  HardDrive,
  AlertTriangle,
  FileText,
  ExternalLink,
  Link2,
  ShieldCheck,
} from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import {
  cx,
  formatBytes,
  formatDate,
  formatEta,
  formatSpeed,
  percent,
} from "../lib/format";
import type { ChecksumVerification } from "../lib/types";
import { StatusBadge, statusLabel } from "./StatusBadge";
import { SpeedChart } from "./SpeedChart";

type Tab = "overview" | "segments" | "info";

const LIMITS: Array<{ label: string; value: number | null }> = [
  { label: "不限速", value: null },
  { label: "1 MB/s", value: 1024 * 1024 },
  { label: "2 MB/s", value: 2 * 1024 * 1024 },
  { label: "5 MB/s", value: 5 * 1024 * 1024 },
  { label: "10 MB/s", value: 10 * 1024 * 1024 },
];

const RING_SIZE = 128;
const RING_STROKE = 7;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2 - 2;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function DetailDrawer() {
  const selectedId = useStore((s) => s.selectedId);
  const task = useStore((s) =>
    s.selectedId ? (s.tasks.find((t) => t.id === s.selectedId) ?? null) : null,
  );
  const select = useStore((s) => s.select);
  const taskLogs = useStore((s) => (s.selectedId ? s.logs[s.selectedId] : undefined)) ?? [];
  const pushToast = useStore((s) => s.pushToast);
  const [tab, setTab] = useState<Tab>("overview");
  const drawerRef = useRef<HTMLElement>(null);
  useFocusTrap(Boolean(task), drawerRef);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteFile, setDeleteFile] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);
  const [freshUrl, setFreshUrl] = useState("");
  const [updatingUrl, setUpdatingUrl] = useState(false);
  const [checksumInput, setChecksumInput] = useState("");
  const [verifyingChecksum, setVerifyingChecksum] = useState(false);
  const [checksumResult, setChecksumResult] = useState<ChecksumVerification | null>(null);

  useEffect(() => {
    setTab("overview");
    setConfirmDelete(false);
    setDeleteFile(false);
    setEditingUrl(false);
    setFreshUrl("");
    setChecksumInput(task?.expectedChecksum ?? "");
    setChecksumResult(null);
  }, [selectedId]);

  useEffect(() => {
    if (!task) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (confirmDelete) setConfirmDelete(false);
        else select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [task, confirmDelete, select]);

  if (!task) return null;

  const pct = percent(task);
  const isActive = task.status === "downloading" || task.status === "connecting";
  const done = task.status === "completed";
  const failed = task.status === "failed";
  const paused = task.status === "paused";
  const pending = task.pendingApproval === true;

  const primary = async () => {
    try {
      if (pending) {
        await backend.approve(task.id);
        pushToast("已允许，开始下载", "success");
      } else if (done) {
        await backend.openFile(task.savePath);
      } else if (isActive) {
        await backend.pause(task.id);
      } else if (failed) {
        await backend.retry(task.id);
      } else if (paused) {
        await backend.resume(task.id);
      } else {
        await backend.pause(task.id);
      }
    } catch (error) {
      pushToast(String(error), "error");
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast(`${label}已复制`, "success");
    } catch {
      pushToast("复制失败，请手动选择文本", "error");
    }
  };

  const limit = async (value: number | null) => {
    try {
      await backend.setTaskSpeedLimit(task.id, value);
      pushToast(value ? `已限速为 ${formatSpeed(value)}` : "已取消限速", "success");
    } catch (error) {
      pushToast(String(error), "error");
    }
  };

  const remove = async () => {
    try {
      await backend.remove(task.id, deleteFile);
      pushToast(deleteFile ? "任务与文件已删除" : "已移出列表，文件保留", "success");
      select(null);
    } catch (error) {
      pushToast(String(error), "error");
    }
  };

  const submitFreshUrl = async () => {
    const trimmed = freshUrl.trim();
    if (!trimmed) {
      pushToast("请先粘贴新的下载链接", "error");
      return;
    }
    setUpdatingUrl(true);
    try {
      await backend.updateTaskUrl(task.id, trimmed, true);
      setEditingUrl(false);
      setFreshUrl("");
      pushToast("已更新下载链接并继续下载", "success");
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setUpdatingUrl(false);
    }
  };

  const submitChecksum = async () => {
    const trimmed = checksumInput.trim();
    if (!trimmed) {
      pushToast("请粘贴 64 位 SHA-256 校验和", "error");
      return;
    }
    setVerifyingChecksum(true);
    try {
      const res = await backend.verifyTaskChecksum(task.id, trimmed);
      setChecksumResult(res);
      if (res.pending) {
        pushToast("已保存预期 SHA-256，下载完成后自动核对", "success");
      } else if (res.matched) {
        pushToast("SHA-256 校验通过，文件完整", "success");
      } else {
        pushToast("SHA-256 校验不匹配，请确认文件来源", "error");
      }
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setVerifyingChecksum(false);
    }
  };

  const primaryLabel = pending
    ? "允许下载"
    : done
      ? "打开文件"
      : isActive
        ? "暂停下载"
        : failed
          ? "重试下载"
          : paused
            ? "继续下载"
            : "暂停";

  const primaryIcon = done ? (
    <ExternalLink size={15} />
  ) : isActive ? (
    <Pause size={15} />
  ) : failed ? (
    <RefreshCw size={14} />
  ) : (
    <Play size={15} />
  );

  return (
    <div className="drawer-backdrop" onClick={() => select(null)}>
      <aside
        ref={drawerRef}
        className="detail-drawer"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="任务详情"
      >
        <header className="drawer-head">
          <div>
            <span className="drawer-eyebrow">
              {task.kind === "media" ? "视频任务" : "HTTP 下载"} · {task.domain}
            </span>
            <h2 title={task.filename}>{task.filename}</h2>
          </div>
          <button className="icon-button" onClick={() => select(null)} aria-label="关闭详情">
            <X size={17} />
          </button>
        </header>

        <div className="drawer-body">
          <section className="drawer-hero">
            <div className="ring-wrap">
              <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
                <circle
                  cx={RING_SIZE / 2}
                  cy={RING_SIZE / 2}
                  r={RING_RADIUS}
                  className="ring-track"
                  strokeWidth={RING_STROKE}
                />
                <circle
                  cx={RING_SIZE / 2}
                  cy={RING_SIZE / 2}
                  r={RING_RADIUS}
                  className={cx("ring-progress", done && "complete", failed && "error")}
                  strokeWidth={RING_STROKE}
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - (done ? 1 : pct / 100))}
                  transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
                />
              </svg>
              <div className="ring-center">
                <span className="ring-percent">
                  {done ? "100" : task.totalBytes ? Math.floor(pct) : "—"}
                  {!done && task.totalBytes ? <small>%</small> : !done ? null : <small>%</small>}
                </span>
                <span className="ring-caption">{statusLabel(task.status)}</span>
              </div>
            </div>
            <div className="hero-side">
              <div className="hero-speed">
                <Zap size={13} />
                {isActive ? formatSpeed(task.speedBps) : "—"}
              </div>
              <div className="hero-meta">
                <span>
                  <HardDrive size={12} />
                  {formatBytes(task.downloadedBytes)} / {task.totalBytes ? formatBytes(task.totalBytes) : "未知"}
                </span>
                <span>
                  <Clock size={12} />
                  {isActive ? `剩余 ${formatEta(task.etaSeconds)}` : done ? "已完成" : "未在传输"}
                </span>
                <span>
                  <Layers size={12} />
                  {task.kind === "media" ? "yt-dlp 视频流" : `${task.connections} 线程${task.resumable ? " · 可续传" : ""}`}
                </span>
              </div>
              <div className="hero-actions">
                <button className="primary-button" onClick={primary}>
                  {primaryIcon}
                  {primaryLabel}
                </button>
                <button
                  className="icon-button outlined"
                  title="打开所在文件夹"
                  onClick={() => backend.openPath(task.savePath)}
                >
                  <FolderOpen size={15} />
                </button>
                <button
                  className="icon-button outlined"
                  title="复制下载链接"
                  onClick={() => copy(task.url, "链接")}
                >
                  <Copy size={15} />
                </button>
              </div>
            </div>
          </section>

          {failed && (
            <div className="drawer-alert">
              <AlertTriangle size={15} />
              <span className="drawer-alert-msg">{task.error ?? "下载失败，请重试或检查链接"}</span>
              <button
                type="button"
                className="drawer-alert-action"
                onClick={() => {
                  setTab("info");
                  setFreshUrl(task.url);
                  setEditingUrl(true);
                }}
              >
                <Link2 size={12} /> 更换链接续传
              </button>
            </div>
          )}

          <div className="drawer-tabs">
            {(["overview", "segments", "info"] as Tab[]).map((value) => (
              <button
                key={value}
                className={cx("drawer-tab", tab === value && "active")}
                onClick={() => setTab(value)}
              >
                {value === "overview" ? "概览" : value === "segments" ? "分片" : "信息"}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <div className="drawer-pane">
              {task.status !== "completed" && (
                <SpeedChart taskId={task.id} speedBps={task.speedBps} active={isActive} />
              )}

              <div className="stat-grid">
                <div className="stat">
                  <span className="stat-label">文件大小</span>
                  <span className="stat-value">{task.totalBytes ? formatBytes(task.totalBytes) : "未知"}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">已下载</span>
                  <span className="stat-value">{formatBytes(task.downloadedBytes)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">添加时间</span>
                  <span className="stat-value">{formatDate(task.createdAt)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">当前状态</span>
                  <span className="stat-value">
                    <StatusBadge status={task.status} scheduledAt={task.scheduledAt} />
                  </span>
                </div>
                {task.status === "paused" && task.scheduledAt != null && task.scheduledAt > 0 && (
                  <div className="stat">
                    <span className="stat-label">计划开始</span>
                    <span className="stat-value">{formatDate(task.scheduledAt)}</span>
                  </div>
                )}
              </div>

              <div className="path-row">
                <span className="stat-label">保存位置</span>
                <div className="path-value">
                  <span title={task.savePath}>{task.savePath}</span>
                  <button className="mini-button" onClick={() => copy(task.savePath, "路径")}>
                    <Copy size={12} />
                  </button>
                </div>
              </div>

              {task.status !== "completed" && (
                <div className="limit-row">
                  <span className="stat-label">
                    <Gauge size={12} /> 任务限速
                  </span>
                  <div className="limit-chips">
                    {LIMITS.map((option) => (
                      <button
                        key={String(option.value)}
                        className={cx(
                          "limit-chip",
                          (task.speedLimit ?? null) === option.value && "active",
                        )}
                        onClick={() => limit(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {task.kind === "media" && (
                <div className="media-note">
                  <FileText size={14} />
                  <span>
                    使用 yt-dlp 抓取站点视频{task.format ? `，格式 ${task.format}` : ""}。
                    可在设置中配置 yt-dlp 与 ffmpeg 路径。
                  </span>
                </div>
              )}
            </div>
          )}

          {tab === "segments" && (
            <div className="drawer-pane">
              {task.segments.length > 1 ? (
                <>
                  <div className="segment-summary">
                    <span>
                      <Layers size={13} /> {task.segments.length} 个分片并行下载
                    </span>
                    <span>
                      {task.segments.filter((s) => s.done).length} 个已完成
                    </span>
                  </div>
                  <div className="segment-list">
                    {task.segments.map((segment) => {
                      const length = segment.end - segment.start + 1;
                      const segPct = length ? (segment.downloaded / length) * 100 : 0;
                      return (
                        <div className="segment-row" key={segment.index}>
                          <span className="segment-index">
                            {(segment.index + 1).toString().padStart(2, "0")}
                          </span>
                          <div className="segment-info">
                            <div className="segment-head">
                              <span>
                                {formatBytes(segment.start)} – {formatBytes(segment.end)}
                              </span>
                              <span className={segment.done ? "segment-done" : ""}>
                                {segment.done ? "完成" : `${Math.floor(segPct)}%`}
                              </span>
                            </div>
                            <div className="segment-track">
                              <div
                                className={cx("segment-fill", segment.done && "done")}
                                style={{ width: `${segPct}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="pane-empty">
                  <Layers size={22} />
                  <p>
                    {task.kind === "media"
                      ? "视频下载由 yt-dlp 处理，可能分片抓取或直接合并。"
                      : "该服务器不支持 Range，或文件较小，使用单连接传输。"}
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === "info" && (
            <div className="drawer-pane">
              <div className="info-list">
                <div className="info-row">
                  <span>来源</span>
                  <div className="info-value">
                    <span className="mono" title={task.url}>
                      {task.url}
                    </span>
                    <button className="mini-button" onClick={() => copy(task.url, "链接")}>
                      <Copy size={12} />
                    </button>
                  </div>
                </div>
                <div className="info-row">
                  <span>任务 ID</span>
                  <span className="mono">{task.id}</span>
                </div>
                <div className="info-row">
                  <span>域名</span>
                  <span>
                    <Globe size={12} /> {task.domain}
                  </span>
                </div>
                <div className="info-row">
                  <span>文件类型</span>
                  <span>{task.mime ?? "未知"}</span>
                </div>
                <div className="info-row">
                  <span>创建时间</span>
                  <span>
                    <Calendar size={12} /> {new Date(task.createdAt).toLocaleString("zh-CN")}
                  </span>
                </div>
                {task.finishedAt && (
                  <div className="info-row">
                    <span>完成时间</span>
                    <span>{new Date(task.finishedAt).toLocaleString("zh-CN")}</span>
                  </div>
                )}
              </div>

              {!done && (
                <div className="drawer-tool-card">
                  <div className="drawer-tool-head">
                    <span>
                      <Link2 size={13} /> 更换下载链接（过期直链续传）
                    </span>
                    {!editingUrl && (
                      <button
                        className="mini-button"
                        onClick={() => {
                          setFreshUrl(task.url);
                          setEditingUrl(true);
                        }}
                      >
                        更换链接
                      </button>
                    )}
                  </div>
                  {editingUrl ? (
                    <div className="drawer-tool-body">
                      <input
                        className="drawer-tool-input mono"
                        type="url"
                        value={freshUrl}
                        onChange={(e) => setFreshUrl(e.target.value)}
                        placeholder="粘贴新的 http(s) 直链，将保留已下载进度..."
                      />
                      <div className="drawer-tool-actions">
                        <button
                          className="drawer-tool-btn primary"
                          disabled={updatingUrl}
                          onClick={() => void submitFreshUrl()}
                        >
                          {updatingUrl ? "更新中..." : "替换并继续"}
                        </button>
                        <button
                          className="drawer-tool-btn"
                          onClick={() => setEditingUrl(false)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="drawer-tool-hint">
                      链接签名过期（403/410）时可替换新直链，引擎会用重叠字节校验安全续传。
                    </p>
                  )}
                </div>
              )}

              <div className="drawer-tool-card">
                <div className="drawer-tool-head">
                  <span>
                    <ShieldCheck size={13} /> SHA-256 完整性核对
                  </span>
                </div>
                <div className="drawer-tool-body">
                  <input
                    className="drawer-tool-input mono"
                    type="text"
                    value={checksumInput}
                    onChange={(e) => setChecksumInput(e.target.value)}
                    placeholder="粘贴官方 64 位 SHA-256（支持 sha256: 前缀）"
                  />
                  <div className="drawer-tool-actions">
                    <button
                      className="drawer-tool-btn primary"
                      disabled={verifyingChecksum}
                      onClick={() => void submitChecksum()}
                    >
                      {verifyingChecksum
                        ? "计算中..."
                        : done
                          ? "立即核对"
                          : "保存待落盘校验"}
                    </button>
                  </div>
                  {checksumResult && (
                    <div
                      className={cx(
                        "checksum-verdict",
                        checksumResult.pending
                          ? "pending"
                          : checksumResult.matched
                            ? "ok"
                            : "mismatch",
                      )}
                    >
                      {checksumResult.pending ? (
                        <span>已登记预期 SHA-256，下载完成落盘前将自动核对。</span>
                      ) : checksumResult.matched ? (
                        <span>校验通过：磁盘文件与预期 SHA-256 完全一致。</span>
                      ) : (
                        <span>
                          校验不匹配！实际值：<code className="mono">{checksumResult.actual}</code>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="log-block">
                <div className="log-head">
                  <span>任务日志</span>
                  <span className="log-count">{taskLogs.length ? `${taskLogs.length} 行` : "暂无"}</span>
                </div>
                {taskLogs.length > 0 ? (
                  <div className="log-lines">
                    {taskLogs.map((line, index) => (
                      <div className="log-line" key={`${line.at}-${index}`}>
                        <span className="log-time">
                          {new Date(line.at).toLocaleTimeString("zh-CN", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                        <span>{line.message}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="log-empty">引擎会在视频解析、重试等事件发生时写入日志。</p>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="drawer-foot">
          {!confirmDelete ? (
            <button className="danger-ghost" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} />
              移出任务
            </button>
          ) : (
            <div className="delete-confirm">
              <label className="delete-check">
                <input
                  type="checkbox"
                  checked={deleteFile}
                  onChange={(event) => setDeleteFile(event.target.checked)}
                />
                同时删除已下载的本地文件
              </label>
              <div className="delete-actions">
                <button className="ghost-button small" onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
                <button className="danger-button small" onClick={remove}>
                  确认移除
                </button>
              </div>
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}
