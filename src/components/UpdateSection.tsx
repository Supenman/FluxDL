import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  History,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  Trash2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useStore } from "../store";
import { backend, isTauri } from "../lib/backend";
import { formatBytes, cx } from "../lib/format";
import type {
  AppVersionInfo,
  AppVersionList,
  ToolVersionItem,
  ToolVersionList,
  UpdateHistoryItem,
  UpdateProgress,
} from "../lib/types";

function formatDay(iso: string): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * 设置页「版本与更新」：当前版本、检查/应用更新、更新历史。
 *
 * 更新只替换应用本体（fluxdl.exe），不重下整个安装包；工具版本在
 * 「视频下载」一节由 `ToolVersionPicker` 单独管理。
 */
export function UpdateSection() {
  const pushToast = useStore((s) => s.pushToast);
  const check = useStore((s) => s.updateCheck);
  const setCheck = useStore((s) => s.setUpdateCheck);
  const staged = useStore((s) => s.stagedUpdate);
  const setStaged = useStore((s) => s.setStagedUpdate);

  const [info, setInfo] = useState<AppVersionInfo | null>(null);
  const [history, setHistory] = useState<UpdateHistoryItem[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [openHistory, setOpenHistory] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [versionInfo, startupNotice, list] = await Promise.all([
        backend.appVersionInfo().catch(() => null),
        backend.takeStartupNotice().catch(() => null),
        backend.appUpdateHistory().catch(() => []),
      ]);
      setInfo(versionInfo);
      setNotice(startupNotice);
      setHistory(list);
    })();
  }, []);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void backend.onUpdateProgress((next) => setProgress(next)).then((fn) => {
      if (cancelled) fn();
      else dispose = fn;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const runCheck = async (force: boolean) => {
    if (checking) return;
    setChecking(true);
    try {
      const result = await backend.checkAppUpdate(force);
      setCheck(result);
      if (result.history.length) setHistory(result.history);
      if (result.error) {
        pushToast(`检查更新失败：${result.error}`, "error");
      } else if (!result.available) {
        pushToast(`已是最新版本（${result.current}）`, "info");
      }
    } catch (error) {
      pushToast(`检查更新失败：${error}`, "error");
    } finally {
      setChecking(false);
    }
  };

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setProgress(null);
    try {
      const result = await backend.downloadAppUpdate();
      setStaged(result);
      pushToast(`v${result.version} 已下载并通过校验，正在重启完成更新…`, "success");
      // 一步到位：下载完成立刻应用，用户不需要再点第二次。
      try {
        await backend.applyAppUpdateAndRestart();
      } catch (error) {
        pushToast(`自动切换未完成（${error}），可点「重启并完成更新」重试`, "error");
      }
    } catch (error) {
      pushToast(`更新失败：${error}`, "error");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const restart = async () => {
    try {
      pushToast(await backend.applyAppUpdateAndRestart(), "info");
    } catch (error) {
      pushToast(`重启失败：${error}`, "error");
    }
  };

  const percent = progress?.total
    ? Math.min(100, (progress.downloaded / progress.total) * 100)
    : 0;

  return (
    <section className="settings-section">
      <div className="section-head">
        <span className="section-icon">
          <Package size={16} />
        </span>
        <div>
          <h2>版本与更新</h2>
          <p>新增功能与修复通过版本清单下发，只替换变化的组件。</p>
        </div>
        <button
          className="mini-refresh"
          onClick={() => void runCheck(true)}
          disabled={checking || !isTauri}
          title="强制联网检查"
        >
          <RefreshCw size={13} className={checking ? "spin" : ""} />
          {checking ? "检查中" : "检查更新"}
        </button>
      </div>

      {notice && (
        <div className="update-notice">
          <ShieldCheck size={15} />
          <span>{notice}</span>
        </div>
      )}

      <div className="about-grid">
        <div className="about-item">
          <span>当前版本</span>
          <strong>v{info?.appVersion ?? "—"}</strong>
        </div>
        <div className="about-item">
          <span>引擎版本</span>
          <strong>{info?.engineVersion ?? "—"}</strong>
        </div>
        <div className="about-item">
          <span>运行平台</span>
          <strong>{info?.platform ?? "—"}</strong>
        </div>
        <div className="about-item">
          <span>交付方式</span>
          <strong>{info ? (info.portable ? "便携版" : "安装版") : "—"}</strong>
        </div>
      </div>

      {staged ? (
        <div className="update-card ready">
          <div className="update-card-head">
            <span className="update-card-badge">
              <Check size={13} /> 已下载，待切换
            </span>
            <strong>v{staged.version}</strong>
            <span className="update-card-size">{formatBytes(staged.size)}</span>
          </div>
          <p>
            新版本已通过 SHA-256 校验并放进版本库 <code>app-versions\&lt;版本&gt;</code>。
            点下面这个按钮会备份当前版本、换上新的并重启；替换失败会自动还原，不满意也能回退。
          </p>
          <div className="update-card-actions">
            <button className="primary-button small" onClick={() => void restart()}>
              <RotateCcw size={13} />
              切换到新版本
            </button>
            <button
              className="ghost-button small"
              onClick={() => {
                setStaged(null);
                pushToast("已取消待安装的更新（暂存文件会在下次检查时清理）", "info");
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : check?.available ? (
        <div className={cx("update-card", check.forced && "forced")}>
          <div className="update-card-head">
            <span className="update-card-badge">
              <ArrowUpCircle size={13} /> 可用更新
            </span>
            <strong>v{check.latest}</strong>
            <span className="update-card-size">
              {check.releasedAt ? formatDay(check.releasedAt) : ""}
              {check.size ? ` · ${formatBytes(check.size)}` : ""}
            </span>
            {check.forced && <span className="update-tag danger">必须更新</span>}
          </div>
          <ul className="update-notes">
            {check.notes.slice(0, 5).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {busy && (
            <div className="update-banner-bar">
              <span style={{ width: percent ? `${percent}%` : "35%" }} />
            </div>
          )}
          <div className="update-card-actions">
            <button className="primary-button small" onClick={() => void download()} disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
              {busy
                ? progress?.phase === "verify"
                  ? "校验中…"
                  : progress?.total
                    ? `下载中 ${Math.round(percent)}%`
                    : "下载中…"
                : "下载并安装"}
            </button>
            <span className="update-source">来源：{check.source || "版本清单"}</span>
          </div>
        </div>
      ) : check?.error ? (
        <div className="update-error">
          <TriangleAlert size={15} />
          <div>
            <strong>检查更新失败</strong>
            <p>{check.error}</p>
            <p className="muted">可以继续使用当前版本；恢复网络后点「检查更新」重试。</p>
          </div>
        </div>
      ) : (
        <div className="update-uptodate">
          <Check size={14} />
          <span>
            {check
              ? `已是最新版本（v${check.current}）`
              : "还没检查过更新，点右上角「检查更新」试试"}
          </span>
        </div>
      )}

      <div className="version-rules">
        <strong>版本号规则</strong>
        <p>
          遵循语义化版本 <code>MAJOR.MINOR.PATCH</code>：主版本号变化表示不兼容改动，次版本号是新增功能，修订号是问题修复。
          带后缀（如 <code>0.2.0-beta.1</code>）为预发布版本，优先级低于同号正式版，默认不推给稳定通道。
        </p>
      </div>

      <button className="history-toggle" onClick={() => setOpenHistory((v) => !v)}>
        <History size={14} />
        更新历史
        <span className="history-count">{history.length}</span>
        {openHistory ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      {openHistory && (
        <ol className="update-history">
          {history.length === 0 && <li className="muted">暂无更新记录</li>}
          {history.map((item) => (
            <li key={item.version}>
              <div className="history-head">
                <strong>v{item.version}</strong>
                <span>{formatDay(item.releasedAt)}</span>
                {item.channel && <span className="update-tag">{item.channel}</span>}
              </div>
              <ul>
                {item.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * 单个工具的版本选择器：列出已装与远端可选版本，支持安装、切换、回滚。
 * 回滚依赖 `previous`（上一次激活过的版本），由后端 ToolState 记录。
 */
export function ToolVersionPicker({
  tool,
  title,
  hint,
}: {
  tool: "yt-dlp" | "ffmpeg";
  title: string;
  hint: string;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const setSettings = useStore((s) => s.setSettings);

  const [list, setList] = useState<ToolVersionList | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const next = await backend.toolVersionList(tool);
      setList(next);
      setSelected((current) =>
        current && next.available.some((v) => v.version === current)
          ? current
          : next.active ?? next.available[0]?.version ?? "",
      );
    } catch (error) {
      pushToast(`读取 ${title} 版本失败：${error}`, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: ToolVersionItem[] = [];
    for (const item of list?.available ?? []) {
      if (seen.has(item.version)) continue;
      seen.add(item.version);
      out.push(item);
    }
    // 远端没列出来但本地装过的版本（例如离线装的随包版本）附在末尾
    for (const item of list?.installed ?? []) {
      if (seen.has(item.version)) continue;
      seen.add(item.version);
      out.push({ ...item, installed: true });
    }
    return out;
  }, [list]);

  const current = options.find((item) => item.version === selected);
  const canSwitch = Boolean(selected) && selected !== list?.active;
  const label = !current
    ? "选择版本"
    : current.installed
      ? "切换到此版本"
      : "下载并切换";

  const apply = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      if (!current?.installed) {
        await backend.toolInstallVersion(tool, selected);
      }
      const item = await backend.toolActivateVersion(tool, selected);
      setSettings(
        tool === "ffmpeg"
          ? { ffmpegPath: item.path ?? undefined }
          : { ytDlpPath: item.path ?? selected },
      );
      pushToast(`${title} 已切换到 ${selected}`, "success");
      await load();
    } catch (error) {
      pushToast(`${title} 切换失败：${error}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const item = await backend.toolRollback(tool);
      setSettings(
        tool === "ffmpeg"
          ? { ffmpegPath: item.path ?? undefined }
          : { ytDlpPath: item.path ?? item.version },
      );
      pushToast(`${title} 已回滚到 ${item.version}`, "info");
      await load();
    } catch (error) {
      pushToast(`${title} 回滚失败：${error}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tool-version">
      <div className="tool-version-head">
        <div className="setting-copy">
          <label>{title} 版本</label>
          <p>
            当前 <strong>{list?.active ?? "未安装"}</strong>
            {list?.previous ? ` · 上一版本 ${list.previous}` : ""}
            {list?.updateAvailable ? " · 有新版本可用" : ""}
          </p>
        </div>
        <div className="tool-version-actions">
          <div className="select-shell">
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={loading || !options.length}
            >
              {options.length === 0 && <option value="">没有可用版本</option>}
              {options.map((item) => (
                <option key={item.version} value={item.version}>
                  {item.version}
                  {item.active ? "（使用中）" : item.installed ? "（已安装）" : ""}
                  {item.size ? ` · ${formatBytes(item.size)}` : ""}
                </option>
              ))}
            </select>
          </div>
          <button
            className="ghost-button small"
            onClick={() => void apply()}
            disabled={!canSwitch || busy || !isTauri}
            title={current?.installed ? "切换到这个已安装版本" : "下载并切换"}
          >
            {busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
            {label}
          </button>
          {list?.previous && (
            <button
              className="ghost-button small"
              onClick={() => void rollback()}
              disabled={busy || !isTauri}
              title={`回滚到 ${list.previous}`}
            >
              <RotateCcw size={13} />
              回滚
            </button>
          )}
          <button
            className="icon-button"
            onClick={() => void load()}
            disabled={loading}
            title="刷新版本列表"
          >
            <RefreshCw size={13} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>
      <p className="tool-version-hint">
        {list?.warning ? list.warning : hint}
      </p>
    </div>
  );
}

/** 语义化版本比较，只用于判断"选中的是不是旧版本"。 */
function compareVersion(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split("-");
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: Boolean(pre) };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  return x.pre ? -1 : 1;
}

/**
 * 「主程序版本」——和 yt-dlp / ffmpeg 一样的管理方式：
 * 多版本共存于 `app-versions\`，选中哪个就切到哪个，全程 2 秒左右。
 *
 * 为什么能这么快：真正运行的是 `FluxDL.App-<ver>.exe`，而"当前用哪个"
 * 只是状态文件里的一行文本。更新只是往目录里多放一个 exe，不覆盖任何
 * 正在运行的文件，所以不需要管理员权限、不需要重装安装包。
 */
export function AppVersionPicker() {
  const pushToast = useStore((s) => s.pushToast);
  const [list, setList] = useState<AppVersionList | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const next = await backend.appVersionList();
      setList(next);
      setSelected((current) =>
        current && next.installed.some((v) => v.version === current)
          ? current
          : next.active,
      );
    } catch (error) {
      pushToast(`读取主程序版本失败：${error}`, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const canSwitch = Boolean(selected) && selected !== list?.active && list?.managed;
  // 选中的比当前旧 → 这是"回退"，语气和按钮都要跟"切换到新版本"区分开。
  const isRollback =
    Boolean(selected && list?.active) &&
    compareVersion(selected, list!.active) < 0;

  const switchTo = async () => {
    if (!selected || busy) return;
    if (isRollback && !window.confirm(`回退到 ${selected}？程序会重启，当前 ${list?.active} 仍保留在版本库里，随时可以切回来。`)) {
      return;
    }
    setBusy(true);
    try {
      await backend.activateAppVersion(selected);
      pushToast(`正在${isRollback ? "回退" : "切换"}到 ${selected}，程序将自动重启`, "info");
      // 替换脚本会在本进程退出后动文件，这里不做后续处理。
    } catch (error) {
      pushToast(`切换失败：${error}`, "error");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const message = await backend.deleteAppVersion(selected);
      pushToast(message, "success");
      await load();
    } catch (error) {
      pushToast(`删除失败：${error}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tool-version">
      <div className="tool-version-head">
        <div className="setting-copy">
          <label>主程序版本</label>
          <p>
            当前 <strong>{list?.active ?? "—"}</strong>
            {list?.previous ? ` · 上一版本 ${list.previous}` : ""}
            {` · 本地保留 ${list?.keep ?? 3} 个版本`}
          </p>
        </div>
        <div className="tool-version-actions">
          <div className="select-shell">
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={loading || !list?.installed.length}
            >
              {!list?.installed.length && <option value="">没有已安装版本</option>}
              {list?.installed.map((item) => (
                <option key={item.version} value={item.version}>
                  {item.version}
                  {item.active ? "（使用中）" : item.previous ? "（上一版本）" : ""}
                  {item.size ? ` · ${formatBytes(item.size)}` : ""}
                </option>
              ))}
            </select>
          </div>
          <button
            className="ghost-button small"
            onClick={() => void switchTo()}
            disabled={!canSwitch || busy || !isTauri}
            title="切换到此版本并重启，约 2 秒"
          >
            {busy ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
            {isRollback ? "回退到此版本" : "切换到此版本"}
          </button>
          <button
            className="ghost-button small"
            onClick={() => void remove()}
            disabled={!selected || busy || selected === list?.active || !isTauri}
            title="删除这个已安装版本（至少保留两个）"
          >
            <Trash2 size={13} />
            删除
          </button>
          <button
            className="icon-button"
            onClick={() => void load()}
            disabled={loading}
            title="刷新版本列表"
          >
            <RefreshCw size={13} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>
      <p className="tool-version-hint">
        {list?.warning
          ? list.warning
          : `版本存放目录：${list?.versionsDir ?? "—"}。切换只改一行状态，不替换正在运行的文件，因此无需重装或管理员权限。`}
      </p>
    </div>
  );
}
