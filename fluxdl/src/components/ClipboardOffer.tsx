import { useState } from "react";
import { Clipboard, Download, Loader2, X, Settings2 } from "lucide-react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import { isMediaUrl } from "../lib/format";

export function ClipboardOffer() {
  const url = useStore((s) => s.clipboardOffer);
  const setOffer = useStore((s) => s.setClipboardOffer);
  const settings = useStore((s) => s.settings);
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  if (!url) return null;

  const kind = isMediaUrl(url) ? "media" : "http";

  const quickAdd = async () => {
    setBusy(true);
    try {
      const result = await backend.addTasks([url], kind, {
        saveDir: settings.saveDir,
        connections: kind === "media" ? 1 : settings.connections,
        speedLimit: null,
      });
      if (result.tasks.length) {
        pushToast("已加入下载队列", "success");
        setOffer(null);
      } else {
        pushToast(result.errors[0] ?? "添加失败", "error");
      }
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="clipboard-offer">
      <span className="clipboard-offer-icon">
        <Clipboard size={15} />
      </span>
      <div className="clipboard-offer-body">
        <span className="clipboard-offer-title">检测到剪贴板链接</span>
        <span className="clipboard-offer-url" title={url}>
          {url}
        </span>
      </div>
      <div className="clipboard-offer-actions">
        <button className="primary-button small" onClick={quickAdd} disabled={busy}>
          {busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
          下载
        </button>
        <button
          className="ghost-button small"
          onClick={() => {
            setNewTaskOpen(true, url);
            setOffer(null);
          }}
          title="打开新建下载并预填链接"
        >
          <Settings2 size={13} />
          选项
        </button>
        <button
          className="icon-button"
          onClick={() => setOffer(null)}
          aria-label="忽略"
          title="忽略"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
