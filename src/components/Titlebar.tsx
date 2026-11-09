import { useStore } from "../store";
import { Logo } from "./Logo";
import {
  Minus,
  Square,
  X,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { isTauri, windowControls } from "../lib/backend";
import pkg from "../../package.json";

export function Titlebar() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const pushToast = useStore((s) => s.pushToast);

  const cycleTheme = () => {
    setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark");
  };

  const themeIcon =
    theme === "dark" ? <Moon size={15} /> : theme === "light" ? <Sun size={15} /> : <Monitor size={15} />;
  const themeLabel =
    theme === "dark" ? "深色模式" : theme === "light" ? "浅色模式" : "跟随系统";

  const guard = (fn: () => Promise<void>) => async () => {
    if (!isTauri) {
      pushToast("预览模式下窗口控制不可用，请运行 Tauri 桌面端", "info");
      return;
    }
    await fn();
  };

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <Logo size={19} />
        <span className="brand-name">FluxDL</span>
        <span className="brand-version">{pkg.version}</span>
        {isTauri ? (
          <span className="engine-chip">
            <span className="live-dot" />
            本地引擎
          </span>
        ) : (
          <span className="preview-chip">预览模式</span>
        )}
      </div>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-actions">
        <button
          className="icon-button theme-button"
          onClick={cycleTheme}
          title={`${themeLabel}，点击切换`}
          aria-label="切换主题"
        >
          {themeIcon}
          <span className="theme-label">{themeLabel}</span>
        </button>
        <div className="window-controls">
          <button
            className="window-button"
            onClick={guard(() => windowControls.minimize())}
            aria-label="最小化"
            title="最小化"
          >
            <Minus size={14} />
          </button>
          <button
            className="window-button"
            onClick={guard(() => windowControls.toggleMaximize())}
            aria-label="最大化"
            title="最大化 / 还原"
          >
            <Square size={12} />
          </button>
          <button
            className="window-button close"
            onClick={guard(() => windowControls.close())}
            aria-label="关闭"
            title="关闭"
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
