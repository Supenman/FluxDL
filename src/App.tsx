import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useStore } from "./store";
import { backend } from "./lib/backend";
import { extractUrls, cx } from "./lib/format";
import { applyAccent } from "./lib/theme";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { TaskList } from "./components/TaskList";
import { StatusBar } from "./components/StatusBar";
import { DetailDrawer } from "./components/DetailDrawer";
import { NewTaskModal } from "./components/NewTaskModal";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsPage } from "./components/SettingsPage";
import { Toasts } from "./components/Toasts";
import { ClipboardOffer } from "./components/ClipboardOffer";
import { UpdateBanner } from "./components/UpdateBanner";
import { ProgressWindow } from "./components/ProgressWindow";

export function App() {
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);
  const accent = useStore((s) => s.accent);
  const setCommandOpen = useStore((s) => s.setCommandOpen);
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
  const [dragging, setDragging] = useState(false);

  // Initial load + engine event stream.
  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;

    backend
      .getEngineOptions()
      .then((options) => {
        if (!alive) return;
        useStore.getState().setSettings(options);
        useStore.getState().setSettingsLoaded(true);
      })
      .catch((error) => {
        // 失败时保持 settingsLoaded=false，设置页会拒绝写回硬编码默认值
        if (alive) useStore.getState().pushToast(`读取设置失败：${error}`, "error");
      });

    backend
      .getTasks()
      .then((tasks) => {
        if (alive) useStore.getState().setTasks(tasks);
      })
      .catch((error) => {
        if (alive) useStore.getState().pushToast(`读取任务列表失败：${error}`, "error");
      });

    backend
      .onEvent((event) => {
        const state = useStore.getState();
        if (event.type === "task") {
          const task = event.payload;
          const previous = state.tasks.find((t) => t.id === task.id);
          state.upsertTask(task);
          if (task.status === "completed" && previous && previous.status !== "completed") {
            state.pushToast(`下载完成：${task.filename}`, "success");
            if (state.settings.openFolderAfter) void backend.openPath(task.savePath);
          }
          if (task.status === "failed" && previous && previous.status !== "failed") {
            state.pushToast(`${task.filename} 下载失败`, "error");
          }
        } else if (event.type === "removed") {
          state.removeTask(event.payload);
        } else if (event.type === "log") {
          state.appendLog(event.payload);
        } else if (event.type === "clipboardUrl") {
          state.setClipboardOffer(event.payload);
        }
      })
      .then((fn) => {
        if (alive) unsubscribe = fn;
        else fn();
      })
      .catch((error) => {
        if (alive) {
          useStore.getState().pushToast(`事件订阅失败，界面可能不会实时刷新：${error}`, "error");
        }
      });

    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  // 启动检查更新：先取上次替换的结果（成功 / 已回滚），再延迟 4 秒静默查新版本。
  // 延迟是为了不和首屏任务加载抢带宽，失败也不打扰用户。
  useEffect(() => {
    void backend
      .takeStartupNotice()
      .then((notice) => {
        if (notice) useStore.getState().pushToast(notice, "info");
      })
      .catch(() => {});

    const timer = window.setTimeout(() => {
      void backend
        .checkAppUpdate(false)
        .then((result) => useStore.getState().setUpdateCheck(result))
        .catch(() => {});
    }, 4000);
    return () => window.clearTimeout(timer);
  }, []);

  // Apply theme (including the follow-system option).
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const actual = theme === "system" ? (media.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.theme = actual;
      document.documentElement.style.colorScheme = actual;
    };
    apply();
    if (theme === "system") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
  }, [theme]);

  // Apply custom accent preset / imported theme (brand originals only; WCAG semantic mapping untouched).
  useEffect(() => {
    applyAccent(accent);
  }, [accent]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(!useStore.getState().commandOpen);
      } else if (mod && event.key.toLowerCase() === "n" && !typing) {
        event.preventDefault();
        setNewTaskOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandOpen, setNewTaskOpen]);

  // Drag & drop links (or text files containing links).
  useEffect(() => {
    let depth = 0;
    const hasDragData = (event: DragEvent) =>
      Boolean(event.dataTransfer?.types?.includes("Files")) ||
      Boolean(event.dataTransfer?.types?.includes("text/plain")) ||
      Boolean(event.dataTransfer?.types?.includes("text/uri-list"));

    const onEnter = (event: DragEvent) => {
      if (!hasDragData(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (!hasDragData(event)) return;
      event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!hasDragData(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = async (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const dt = event.dataTransfer;
      if (!dt) return;
      const text = dt.getData("text/uri-list") || dt.getData("text/plain");
      let urls = extractUrls(text);
      if (!urls.length && dt.files.length) {
        for (const file of Array.from(dt.files)) {
          const textLike =
            file.type.startsWith("text/") ||
            /\.(txt|csv|json|md|url)$/i.test(file.name);
          if (textLike) {
            try {
              urls = urls.concat(extractUrls(await file.text()));
            } catch {
              // ignore unreadable file
            }
          }
        }
      }
      if (urls.length) {
        const unique = Array.from(new Set(urls));
        setNewTaskOpen(true, unique.join("\n"));
      } else {
        useStore.getState().pushToast("没有从拖入内容中找到 http(s) 链接", "error");
      }
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [setNewTaskOpen]);

  return (
    <div className={cx("app", dragging && "is-dragging")}>
      <Titlebar />
      <div className="shell">
        <Sidebar />
        <main className="main">
          {view === "settings" ? (
            <SettingsPage />
          ) : (
            <>
              <UpdateBanner />
              <Toolbar />
              <div className="list-scroll">
                <TaskList />
              </div>
            </>
          )}
        </main>
      </div>
      <StatusBar />
      <DetailDrawer />
      <ProgressWindow />
      <NewTaskModal />
      <CommandPalette />
      <Toasts />
      <ClipboardOffer />
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-icon">
              <Download size={30} />
            </div>
            <h2>松开即可添加下载</h2>
            <p>支持链接文本、.txt / .csv 列表文件</p>
          </div>
        </div>
      )}
    </div>
  );
}
