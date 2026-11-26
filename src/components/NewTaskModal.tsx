import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  X,
  Link2,
  Clipboard,
  FolderOpen,
  ChevronDown,
  Sparkles,
  Film,
  FileDown,
  AlertTriangle,
  Loader2,
  FileText,
} from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import { matchSiteRule, readSiteRules } from "../lib/siteRules";
import { cx, countUrls, extractUrls, formatBytes, isMediaUrl } from "../lib/format";
import type { HubListing, TaskKind, UrlProbeInfo } from "../lib/types";

type Mode = "auto" | "file" | "media";

const FORMATS = [
  { value: "bv*+ba/b", label: "最佳画质（自动合并）" },
  { value: "bv*[height<=1080]+ba/b", label: "1080p 及以下" },
  { value: "bv*[height<=720]+ba/b", label: "720p 及以下" },
  { value: "ba/b", label: "仅音频" },
];

const SPEED_LIMITS = [
  { value: null, label: "不限速" },
  { value: 1024 * 1024, label: "1 MB/s" },
  { value: 2 * 1024 * 1024, label: "2 MB/s" },
  { value: 5 * 1024 * 1024, label: "5 MB/s" },
  { value: 10 * 1024 * 1024, label: "10 MB/s" },
];

function looksLikeHubUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    const h = u.hostname.toLowerCase();
    const p = u.pathname;
    if ((h === "huggingface.co" || h === "hf-mirror.com") && !p.includes("/resolve/")) {
      return p.split("/").filter(Boolean).length >= 2;
    }
    if (h === "github.com" && p.includes("/releases") && !p.includes("/releases/download/")) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function NewTaskModal() {
  const open = useStore((s) => s.newTaskOpen);
  const seed = useStore((s) => s.newTaskSeed);
  const settings = useStore((s) => s.settings);
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
  const pushToast = useStore((s) => s.pushToast);
  const select = useStore((s) => s.select);

  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [saveDir, setSaveDir] = useState(settings.saveDir);
  const [connections, setConnections] = useState(settings.connections);
  const [limit, setLimit] = useState<number | null>(null);
  const [format, setFormat] = useState("bv*+ba/b");
  const [advanced, setAdvanced] = useState(false);
  const [referer, setReferer] = useState("");
  const [proxy, setProxy] = useState("");
  const [userAgent, setUserAgent] = useState("");
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeInfo, setProbeInfo] = useState<UrlProbeInfo | null>(null);
  const [customFilename, setCustomFilename] = useState("");
  const [resolvingHub, setResolvingHub] = useState(false);
  const [hubListing, setHubListing] = useState<HubListing | null>(null);
  const [hubSelected, setHubSelected] = useState<Set<string>>(() => new Set());
  const [importedFile, setImportedFile] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, modalRef);

  useEffect(() => {
    if (!open) return;
    setText(seed);
    setMode("auto");
    setSaveDir(settings.saveDir);
    setConnections(settings.connections);
    setLimit(null);
    setFormat("bv*+ba/b");
    setAdvanced(false);
    setReferer("");
    setProxy("");
    setUserAgent("");
    setScheduleLocal("");
    setErrors([]);
    setProbeInfo(null);
    setCustomFilename("");
    setHubListing(null);
    setHubSelected(new Set());
    setImportedFile(null);
    window.setTimeout(() => textareaRef.current?.focus(), 60);
    // Only reset when the modal opens, not when settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) setNewTaskOpen(false);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !submitting) {
        void submit();
      }
    };
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, submitting, text, mode, saveDir, connections, limit, format, referer, proxy, userAgent, scheduleLocal]);

  const urls = useMemo(() => extractUrls(text), [text]);
  const urlCounts = useMemo(() => countUrls(text), [text]);
  const duplicateCount = Math.max(0, urlCounts.raw - urlCounts.unique);

  const resolved = useMemo(() => {
    if (mode === "file") return urls.map((url) => ({ url, kind: "http" as TaskKind }));
    if (mode === "media") return urls.map((url) => ({ url, kind: "media" as TaskKind }));
    return urls.map((url) => ({
      url,
      kind: (isMediaUrl(url) ? "media" : "http") as TaskKind,
    }));
  }, [urls, mode]);

  const mediaCount = resolved.filter((item) => item.kind === "media").length;
  const fileCount = resolved.length - mediaCount;

  if (!open) return null;

  const paste = async () => {
    try {
      const clipboard = await navigator.clipboard.readText();
      if (clipboard.trim()) {
        setText((prev) => (prev.trim() ? `${prev.trim()}\n${clipboard.trim()}` : clipboard.trim()));
      }
    } catch {
      pushToast("无法读取剪贴板，请直接按 Ctrl+V 粘贴", "error");
    }
  };

  const pickFolder = async () => {
    const picked = await backend.pickFolder(saveDir);
    if (picked) setSaveDir(picked);
  };

  // 批量导入：从 .txt / .csv / .md / .url 文本文件中读取链接，追加到输入框。
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const chunks: string[] = [];
    const names: string[] = [];
    for (const file of Array.from(files)) {
      const textLike = file.type.startsWith("text/") || /\.(txt|csv|json|md|url)$/i.test(file.name);
      if (!textLike) {
        names.push(`${file.name}（非文本文件，跳过）`);
        continue;
      }
      try {
        const content = await file.text();
        if (extractUrls(content).length) {
          chunks.push(content.trim());
          names.push(file.name);
        } else {
          names.push(`${file.name}（未找到链接）`);
        }
      } catch {
        names.push(`${file.name}（读取失败）`);
      }
    }
    if (chunks.length) {
      const incoming = chunks.join("\n");
      setText((prev) => (prev.trim() ? `${prev.trim()}\n${incoming}` : incoming));
    }
    setImportedFile(names.join("、"));
  };

  const singleUrl = urls.length === 1 ? urls[0] : null;
  const canResolveHub = Boolean(singleUrl && looksLikeHubUrl(singleUrl));

  async function runProbe() {
    if (!singleUrl || probing) return;
    setProbing(true);
    setProbeInfo(null);
    try {
      const info = await backend.probeUrl(singleUrl);
      setProbeInfo(info);
      setCustomFilename(info.filename);
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setProbing(false);
    }
  }

  async function runResolveHub() {
    if (!singleUrl || resolvingHub) return;
    setResolvingHub(true);
    setHubListing(null);
    try {
      const listing = await backend.resolveHubUrl(singleUrl);
      setHubListing(listing);
      setHubSelected(new Set(listing.files.map((f) => f.path)));
      if (listing.files.length === 0) {
        pushToast("该页面未找到可下载的文件资产", "info");
      } else {
        pushToast(`已解析 ${listing.files.length} 个文件（自动附带官方校验和）`, "success");
      }
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setResolvingHub(false);
    }
  }

  async function submitHubFiles(startLater: boolean) {
    if (!hubListing || hubSelected.size === 0 || submitting) return;
    setSubmitting(true);
    setErrors([]);
    let added = 0;
    const allErrors: string[] = [];
    const createdIds: string[] = [];
    let firstId: string | null = null;
    try {
      const picked = hubListing.files.filter((f) => hubSelected.has(f.path));
      const activeSiteRules = readSiteRules();
      for (const file of picked) {
        const rule = matchSiteRule(file.url, activeSiteRules);
        const result = await backend.addTasks([file.url], "http", {
          saveDir,
          filename: file.filename,
          connections: rule?.connections ?? connections,
          speedLimit: limit ?? rule?.speedLimit ?? null,
          referer: referer.trim() || rule?.referer?.trim() || null,
          proxy: proxy.trim() || null,
          userAgent: userAgent.trim() || rule?.userAgent?.trim() || null,
          expectedChecksum: file.sha256 ?? null,
        });
        added += result.tasks.length;
        for (const t of result.tasks) createdIds.push(t.id);
        if (!firstId && result.tasks[0]) firstId = result.tasks[0].id;
        allErrors.push(...result.errors);
      }
      if (startLater && createdIds.length > 0) {
        for (const id of createdIds) {
          try { await backend.pause(id); } catch { /* ignore */ }
        }
      }
      if (added > 0) {
        pushToast(
          startLater
            ? `已加入稍后下载队列（${added} 个仓库文件）`
            : `已添加 ${added} 个仓库文件（含官方 SHA-256 校验）`,
          "success",
        );
        if (firstId) select(firstId);
      }
      if (allErrors.length > 0) setErrors(allErrors);
      else setNewTaskOpen(false);
    } catch (error) {
      setErrors([String(error)]);
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(startLater = false) {
    if (submitting || urls.length === 0) return;
    // B2 定时下载：解析本地时间输入为 UTC 毫秒时间戳；过去时间直接拒绝，避免静默立即下载。
    let scheduledAt: number | null = null;
    if (scheduleLocal) {
      const parsed = new Date(scheduleLocal).getTime();
      if (!Number.isFinite(parsed) || parsed <= Date.now()) {
        setErrors(["定时时间必须是未来的时刻"]);
        return;
      }
      scheduledAt = parsed;
    }
    setSubmitting(true);
    setErrors([]);
    const groups: Array<{ kind: TaskKind; urls: string[] }> = [];
    for (const item of resolved) {
      const group = groups.find((g) => g.kind === item.kind);
      if (group) group.urls.push(item.url);
      else groups.push({ kind: item.kind, urls: [item.url] });
    }

    let added = 0;
    const allErrors: string[] = [];
    const createdIds: string[] = [];
    let firstId: string | null = null;
    try {
      const activeSiteRules = readSiteRules();
      for (const group of groups) {
        // 若存在命中的站点规则，按规则拆分提交以精确应用每站连接数 / 限速 / Referer / UA。
        const hasAnyRule = group.urls.some((u) => matchSiteRule(u, activeSiteRules) !== null);
        if (!hasAnyRule) {
          const autoReferer =
            referer.trim() ||
            (group.kind === "media" && group.urls[0] ? group.urls[0] : null);
          const result = await backend.addTasks(group.urls, group.kind, {
            saveDir,
            filename: urls.length === 1 && customFilename.trim() ? customFilename.trim() : undefined,
            connections: group.kind === "media" ? 1 : connections,
            speedLimit: limit,
            referer: autoReferer,
            proxy: proxy.trim() || null,
            userAgent: userAgent.trim() || null,
            format: group.kind === "media" ? format : null,
            scheduledAt,
          });
          added += result.tasks.length;
          for (const t of result.tasks) createdIds.push(t.id);
          if (!firstId && result.tasks[0]) firstId = result.tasks[0].id;
          allErrors.push(...result.errors);
        } else {
          for (const singleUrl of group.urls) {
            const rule = matchSiteRule(singleUrl, activeSiteRules);
            const effectiveReferer =
              referer.trim() ||
              rule?.referer?.trim() ||
              (group.kind === "media" ? singleUrl : null);
            const effectiveUa = userAgent.trim() || rule?.userAgent?.trim() || null;
            const effectiveConnections =
              group.kind === "media"
                ? 1
                : rule?.connections ?? connections;
            const effectiveLimit = limit ?? rule?.speedLimit ?? null;
            const result = await backend.addTasks([singleUrl], group.kind, {
              saveDir,
              filename: urls.length === 1 && customFilename.trim() ? customFilename.trim() : undefined,
              connections: effectiveConnections,
              speedLimit: effectiveLimit,
              referer: effectiveReferer,
              proxy: proxy.trim() || null,
              userAgent: effectiveUa,
              format: group.kind === "media" ? format : null,
              scheduledAt,
            });
            added += result.tasks.length;
            for (const t of result.tasks) createdIds.push(t.id);
            if (!firstId && result.tasks[0]) firstId = result.tasks[0].id;
            allErrors.push(...result.errors);
          }
        }
      }
      if (startLater && createdIds.length > 0) {
        for (const id of createdIds) {
          try {
            await backend.pause(id);
          } catch {
            // ignore
          }
        }
      }
      if (added > 0) {
        pushToast(
          startLater
            ? `已加入稍后下载队列（${added} 个任务，保持暂停）`
            : `已添加 ${added} 个下载任务`,
          "success",
        );
        setNewTaskOpen(false);
        if (added === 1 && firstId) select(firstId);
      } else {
        setErrors(allErrors.length ? allErrors : ["没有可下载的链接"]);
      }
    } catch (error) {
      setErrors([String(error)]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) setNewTaskOpen(false);
      }}
    >
      <div ref={modalRef} className="modal new-task-modal" role="dialog" aria-modal="true" aria-label="新建下载">
        <header className="modal-head">
          <div className="modal-title">
            <div className="modal-icon">
              <Link2 size={17} />
            </div>
            <div>
              <h2>新建下载</h2>
              <p>支持批量链接、文本文件导入与站点视频，自动去重</p>
            </div>
          </div>
          <button
            className="icon-button"
            onClick={() => !submitting && setNewTaskOpen(false)}
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </header>

        <div className="modal-body">
          <div className="mode-switch">
            {(
              [
                { id: "auto", label: "自动识别", icon: Sparkles },
                { id: "file", label: "普通文件", icon: FileDown },
                { id: "media", label: "视频链接", icon: Film },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={cx("mode-button", mode === id && "active")}
                onClick={() => setMode(id)}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

          <div className="url-field">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={"每行一个链接，例如：\nhttps://example.com/archive.zip\nhttps://www.youtube.com/watch?v=…\n\n也可以直接粘贴一整段含链接的文字"}
              spellCheck={false}
              rows={5}
            />
            <div className="url-field-tools">
              <button className="paste-button" onClick={paste} title="从剪贴板粘贴">
                <Clipboard size={13} />
                粘贴
              </button>
              <button
                className="paste-button"
                onClick={() => fileInputRef.current?.click()}
                title="从 .txt / .csv / .md 文件批量导入链接"
              >
                <FileText size={13} />
                导入文件
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,.json,.md,.url,text/plain"
                multiple
                hidden
                onChange={(event) => {
                  void importFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          </div>

          <div className="url-summary">
            <span className={cx("summary-main", urls.length === 0 && "muted")}>
              <Link2 size={12} />
              {urls.length === 0 ? "等待粘贴链接" : `已识别 ${urls.length} 个链接`}
            </span>
            {duplicateCount > 0 && (
              <span className="summary-chip dup" title="自动去重，不会重复添加">
                去重 -{duplicateCount}
              </span>
            )}
            {fileCount > 0 && <span className="summary-chip">文件 {fileCount}</span>}
            {mediaCount > 0 && <span className="summary-chip media">视频 {mediaCount}</span>}
            {importedFile && (
              <span className="summary-imported" title={importedFile}>
                <FileText size={11} /> {importedFile}
              </span>
            )}
          </div>

          {singleUrl && (
            <div className="modal-probe-bar">
              {canResolveHub ? (
                <button
                  type="button"
                  className="drawer-tool-btn primary"
                  disabled={resolvingHub}
                  onClick={() => void runResolveHub()}
                >
                  {resolvingHub ? "正在拉取文件列表…" : "解析 HuggingFace / Release 文件列表"}
                </button>
              ) : (
                <button
                  type="button"
                  className="drawer-tool-btn"
                  disabled={probing}
                  onClick={() => void runProbe()}
                >
                  {probing ? "探测中…" : "探测文件信息（大小/文件名）"}
                </button>
              )}
              {probeInfo && (
                <span className="modal-probe-meta">
                  {probeInfo.totalBytes > 0 ? formatBytes(probeInfo.totalBytes) : "未知大小"}
                  {" · "}
                  {probeInfo.resumable ? "支持续传" : "单流"}
                </span>
              )}
            </div>
          )}

          {probeInfo && urls.length === 1 && (
            <div className="modal-probe-card">
              <label>保存文件名（探测结果，可直接修改）</label>
              <input
                className="drawer-tool-input mono"
                value={customFilename}
                onChange={(e) => setCustomFilename(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}

          {hubListing && hubListing.files.length > 0 && (
            <div className="hub-picker">
              <div className="hub-picker-head">
                <span>
                  {hubListing.source} · {hubListing.title}（已选 {hubSelected.size}/{hubListing.files.length}）
                </span>
                <button
                  type="button"
                  className="mini-button"
                  onClick={() => {
                    if (hubSelected.size === hubListing.files.length) {
                      setHubSelected(new Set());
                    } else {
                      setHubSelected(new Set(hubListing.files.map((f) => f.path)));
                    }
                  }}
                >
                  {hubSelected.size === hubListing.files.length ? "全不选" : "全选"}
                </button>
              </div>
              <div className="hub-picker-list">
                {hubListing.files.map((file) => {
                  const checked = hubSelected.has(file.path);
                  return (
                    <label className="hub-file-row" key={file.path}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setHubSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(file.path)) next.delete(file.path);
                            else next.add(file.path);
                            return next;
                          });
                        }}
                      />
                      <span className="hub-file-name mono" title={file.path}>
                        {file.filename}
                      </span>
                      {file.sha256 && <span className="hub-sha-tag" title={file.sha256}>SHA256</span>}
                      <span className="hub-file-size">
                        {file.size > 0 ? formatBytes(file.size) : "—"}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="form-grid">
            <div className="field span-2">
              <label>保存到</label>
              <div className="input-with-button">
                <input
                  value={saveDir}
                  onChange={(event) => setSaveDir(event.target.value)}
                  spellCheck={false}
                />
                <button className="input-button" onClick={pickFolder} title="选择文件夹">
                  <FolderOpen size={14} />
                </button>
              </div>
            </div>

            {fileCount > 0 && (
              <>
                <div className="field">
                  <label>
                    下载线程
                    <span className="field-value">{connections === 0 ? "自动" : connections}</span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={16}
                    value={connections}
                    onChange={(event) => setConnections(Number(event.target.value))}
                    className="slider"
                    style={{ "--fill": `${(connections / 16) * 100}%` } as CSSProperties}
                  />
                  <span className="field-hint">自动按文件大小选线程；0 = 自动</span>
                </div>
                <div className="field">
                  <label>任务限速</label>
                  <div className="select-shell full">
                    <select
                      value={limit ?? "0"}
                      onChange={(event) =>
                        setLimit(event.target.value === "0" ? null : Number(event.target.value))
                      }
                    >
                      {SPEED_LIMITS.map((option) => (
                        <option key={String(option.value)} value={option.value ?? "0"}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={13} className="select-caret" />
                  </div>
                </div>
              </>
            )}

            {mediaCount > 0 && (
              <div className="field">
                <label>视频格式</label>
                <div className="select-shell full">
                  <select value={format} onChange={(event) => setFormat(event.target.value)}>
                    {FORMATS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} className="select-caret" />
                </div>
                <span className="field-hint">需要本机已安装 yt-dlp，合并视频还需要 ffmpeg</span>
              </div>
            )}
          </div>

          <button className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}>
            <ChevronDown size={14} className={cx("advanced-caret", advanced && "open")} />
            高级选项
            <span className="advanced-hint">Referer / 代理 / 定时下载</span>
          </button>

          {advanced && (
            <div className="form-grid advanced-grid">
              <div className="field">
                <label>Referer</label>
                <input
                  value={referer}
                  onChange={(event) => setReferer(event.target.value)}
                  placeholder="可选，部分站点防盗链需要"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label>代理</label>
                <input
                  value={proxy}
                  onChange={(event) => setProxy(event.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  spellCheck={false}
                />
              </div>
              <div className="field span-2">
                <label>User-Agent</label>
                <input
                  value={userAgent}
                  onChange={(event) => setUserAgent(event.target.value)}
                  placeholder="留空则使用全局默认 UA"
                  spellCheck={false}
                />
              </div>
              <div className="field span-2">
                <label>定时下载</label>
                <input
                  type="datetime-local"
                  value={scheduleLocal}
                  onChange={(event) => setScheduleLocal(event.target.value)}
                />
                <span className="field-hint">留空则立即开始；选择未来时间后任务将等待到点自动下载</span>
              </div>
            </div>
          )}

          {errors.length > 0 && (
            <div className="modal-errors">
              <AlertTriangle size={14} />
              <div>
                {errors.slice(0, 4).map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <span className="modal-foot-hint">
            提示：<kbd>Ctrl</kbd> + <kbd>Enter</kbd> 快速开始
          </span>
          <div className="modal-foot-actions">
            <button className="ghost-button" onClick={() => setNewTaskOpen(false)} disabled={submitting}>
              取消
            </button>
            <button
              className="ghost-button"
              onClick={() => void (hubListing ? submitHubFiles(true) : submit(true))}
              disabled={(hubListing ? hubSelected.size === 0 : urls.length === 0) || submitting}
              title="添加到列表并保持暂停，稍后再开始下载"
            >
              稍后下载
            </button>
            <button
              className="primary-button"
              onClick={() => void (hubListing ? submitHubFiles(false) : submit(false))}
              disabled={(hubListing ? hubSelected.size === 0 : urls.length === 0) || submitting}
            >
              {submitting ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
              {hubListing ? `下载所选文件（${hubSelected.size}）` : urls.length > 0 ? `开始下载（${urls.length}）` : "开始下载"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
