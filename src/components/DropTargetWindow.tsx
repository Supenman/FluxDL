import { useState } from "react";
import { Download, Check } from "lucide-react";
import { backend } from "../lib/backend";
import { extractUrls } from "../lib/format";

/**
 * 桌面置顶拖拽悬浮球（参考 MDM Drop Target）：
 * - 拖动任意位置移动
 * - 拖入浏览器链接/文本直接开始下载
 * - 双击唤起主窗口
 */
export function DropTargetWindow() {
  const [over, setOver] = useState(false);
  const [flash, setFlash] = useState<"idle" | "ok" | "err">("idle");

  const triggerFlash = (state: "ok" | "err") => {
    setFlash(state);
    window.setTimeout(() => setFlash("idle"), 1100);
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setOver(false);
    const dt = event.dataTransfer;
    const raw = dt.getData("text/uri-list") || dt.getData("text/plain") || "";
    const urls = Array.from(new Set(extractUrls(raw)));
    if (urls.length === 0) {
      triggerFlash("err");
      return;
    }
    try {
      const opts = await backend.getEngineOptions();
      await backend.addTasks(urls, "http", {
        saveDir: opts.saveDir,
      });
      triggerFlash("ok");
    } catch {
      triggerFlash("err");
    }
  };

  return (
    <div
      className={`drop-orb${over ? " is-over" : ""}${flash === "ok" ? " is-ok" : ""}${flash === "err" ? " is-err" : ""}`}
      data-tauri-drag-region
      title="拖入链接直接下载 · 双击打开 FluxDL 主窗口"
      onDoubleClick={() => void backend.showMainWindow()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => void onDrop(e)}
    >
      {flash === "ok" ? <Check size={24} /> : <Download size={22} />}
    </div>
  );
}
