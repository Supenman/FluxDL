import { useMemo } from "react";
import { Clipboard, Wifi, ArrowDownToLine, Command } from "lucide-react";
import { useStore } from "../store";
import { formatBytes, formatSpeed } from "../lib/format";
import { isTauri } from "../lib/backend";

export function StatusBar() {
  const tasks = useStore((s) => s.tasks);
  const settings = useStore((s) => s.settings);

  const { speed, active, transferred } = useMemo(() => {
    let speed = 0;
    let active = 0;
    let transferred = 0;
    for (const task of tasks) {
      transferred += task.downloadedBytes;
      if (task.status === "downloading" || task.status === "connecting") {
        active += 1;
        speed += task.speedBps;
      }
    }
    return { speed, active, transferred };
  }, [tasks]);

  return (
    <footer className="statusbar">
      <div className="status-left">
        <span className="status-item">
          <Wifi size={12} className={active > 0 ? "status-live" : "status-idle"} />
          {active > 0 ? `${active} 个任务传输中` : "引擎空闲"}
        </span>
        <span className="status-divider" />
        <span className="status-item">
          <ArrowDownToLine size={12} />
          {formatSpeed(speed)}
        </span>
        <span className="status-divider" />
        <span className="status-item dim">累计 {formatBytes(transferred)}</span>
        <span className="status-divider" />
        <span className="status-item dim">
          <Clipboard size={12} />
          剪贴板监听{settings.clipboardWatch ? "已开启" : "已关闭"}
        </span>
      </div>
      <div className="status-right">
        <span className="status-item dim">
          {isTauri ? "FluxDL 桌面引擎" : "浏览器预览 · 数据为演示内容"}
        </span>
        <span className="status-divider" />
        <span className="status-item dim kbd-hint">
          <Command size={11} /> K 命令面板
        </span>
      </div>
    </footer>
  );
}
