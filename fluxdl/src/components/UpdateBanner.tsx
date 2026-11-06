import { useEffect, useState } from "react";
import { ArrowUpCircle, Loader2, RotateCw, X } from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import { formatBytes } from "../lib/format";
import type { UpdateProgress } from "../lib/types";

/**
 * 有可用更新时的醒目横幅。
 *
 * 放在任务列表顶部（主界面视线最先落到的位置），只在「确实有新版本」且
 * 用户没有对**这个版本**点过「稍后」时出现；出现新版本会重新提示。
 */
export function UpdateBanner() {
  const check = useStore((s) => s.updateCheck);
  const hidden = useStore((s) => s.hiddenUpdateVersion);
  const staged = useStore((s) => s.stagedUpdate);
  const hideUpdate = useStore((s) => s.hideUpdate);
  const setStaged = useStore((s) => s.setStagedUpdate);
  const pushToast = useStore((s) => s.pushToast);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

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

  if (!check?.available && !staged) return null;
  if (!staged && check && hidden === check.latest) return null;

  const version = staged?.version ?? check?.latest ?? "";
  const notes = check?.notes ?? [];

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setProgress(null);
    try {
      const result = await backend.downloadAppUpdate();
      setStaged(result);
      pushToast(`新版本 ${result.version} 已下载，重启后生效`, "success");
    } catch (error) {
      pushToast(`更新失败：${error}`, "error");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const restart = async () => {
    try {
      const message = await backend.applyAppUpdateAndRestart();
      pushToast(message, "info");
    } catch (error) {
      pushToast(`重启失败：${error}`, "error");
    }
  };

  const percent = progress?.total
    ? Math.min(100, (progress.downloaded / progress.total) * 100)
    : 0;

  return (
    <div className={staged ? "update-banner ready" : "update-banner"}>
      <span className="update-banner-icon">
        {staged ? <RotateCw size={18} /> : <ArrowUpCircle size={18} />}
      </span>

      <div className="update-banner-main">
        <div className="update-banner-title">
          {staged ? (
            <>
              新版本 <strong>{version}</strong> 已就绪，重启后生效
            </>
          ) : (
            <>
              发现新版本 <strong>{version}</strong>
              {check?.forced && <span className="update-tag danger">必须更新</span>}
              {check?.size ? (
                <span className="update-tag">{formatBytes(check.size)}</span>
              ) : null}
            </>
          )}
        </div>
        <div className="update-banner-notes">
          {staged
            ? "下载已完成并通过校验，重启 FluxDL 即可切换到新版本；不满意可随时回滚。"
            : notes[0] ?? "点击立即更新，只下载变化的部分，不用重新装整个包。"}
        </div>
        {busy && (
          <div className="update-banner-bar">
            <span style={{ width: percent ? `${percent}%` : "35%" }} />
          </div>
        )}
      </div>

      <div className="update-banner-actions">
        {staged ? (
          <button className="primary-button small" onClick={() => void restart()}>
            <RotateCw size={13} />
            立即重启
          </button>
        ) : (
          <button
            className="primary-button small"
            onClick={() => void download()}
            disabled={busy}
          >
            {busy ? <Loader2 size={13} className="spin" /> : <ArrowUpCircle size={13} />}
            {busy
              ? progress?.phase === "verify"
                ? "校验中"
                : progress?.total
                  ? `${Math.round(percent)}%`
                  : "下载中"
              : "立即更新"}
          </button>
        )}
        <button
          className="icon-button"
          title="稍后提醒"
          onClick={() => hideUpdate(version)}
          disabled={busy}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
