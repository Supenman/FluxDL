import { useState } from "react";
import { ShieldCheck, Check, X, Loader2 } from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";

/**
 * 下载审核闸门横幅。
 *
 * 任何来源的新任务（手动 / 剪贴板 / 浏览器扩展）都先停在「待审核」，不下载。
 * 这里汇总数量，让用户一键放行或全部拒绝；逐条操作在任务行上。
 */
export function ApprovalBanner() {
  const tasks = useStore((s) => s.tasks);
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  const pending = tasks.filter((t) => t.pendingApproval === true);
  if (pending.length === 0) return null;

  const approveAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await backend.approveAll();
      pushToast(`已允许 ${pending.length} 条下载`, "success");
    } catch (error) {
      pushToast(`操作失败：${error}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const rejectAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await Promise.all(pending.map((t) => backend.remove(t.id, false)));
      pushToast(`已拒绝 ${pending.length} 条下载`, "info");
    } catch (error) {
      pushToast(`操作失败：${error}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="update-banner approval-banner">
      <span className="update-banner-icon">
        <ShieldCheck size={18} />
      </span>
      <div className="update-banner-main">
        <div className="update-banner-title">
          <span className="approval-count">{pending.length} 条下载等待你的允许</span>
        </div>
        <div className="update-banner-notes">
          未经允许不会开始下载 · 可在每条任务上单独允许或拒绝
        </div>
      </div>
      <div className="update-banner-actions">
        <button
          className="primary-button small"
          onClick={() => void approveAll()}
          disabled={busy}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
          全部允许
        </button>
        <button
          className="ghost-button small"
          onClick={() => void rejectAll()}
          disabled={busy}
        >
          <X size={13} />
          全部拒绝
        </button>
      </div>
    </div>
  );
}
