import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  Search,
  Plus,
  Pause,
  Play,
  Settings,
  SunMoon,
  FolderOpen,
  Clipboard,
  CheckCircle2,
  Film,
  ArrowDownToLine,
  Trash2,
  CornerDownLeft,
  type LucideIcon,
} from "lucide-react";
import { useStore, sortTasks } from "../store";
import { backend } from "../lib/backend";
import { extractUrls } from "../lib/format";
import { cx } from "../lib/format";
import { statusLabelMaybe } from "../lib/resolve";
import type { Task } from "../lib/types";

interface CommandItem {
  id: string;
  label: string;
  desc?: string;
  icon: LucideIcon;
  keywords: string;
  group: "action" | "task";
  run: () => void;
  task?: Task;
}

export function CommandPalette() {
  const open = useStore((s) => s.commandOpen);
  const tasks = useStore((s) => s.tasks);
  const settings = useStore((s) => s.settings);
  const theme = useStore((s) => s.theme);
  const setOpen = useStore((s) => s.setCommandOpen);
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
  const setView = useStore((s) => s.setView);
  const setFilter = useStore((s) => s.setFilter);
  const setTheme = useStore((s) => s.setTheme);
  const select = useStore((s) => s.select);
  const pushToast = useStore((s) => s.pushToast);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, paletteRef);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const activeCount = tasks.filter(
    (t) => t.status === "downloading" || t.status === "connecting",
  ).length;
  const pausedCount = tasks.filter(
    (t) => t.status === "paused" || t.status === "failed",
  ).length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;

  const close = () => setOpen(false);

  const actions = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [
      {
        id: "new",
        label: "新建下载",
        desc: "粘贴一个或多个链接",
        icon: Plus,
        keywords: "new download url 新建 下载",
        group: "action",
        run: () => setNewTaskOpen(true),
      },
      {
        id: "clipboard",
        label: "从剪贴板添加链接",
        desc: "读取当前剪贴板中的 URL",
        icon: Clipboard,
        keywords: "clipboard paste 剪贴板 粘贴",
        group: "action",
        run: async () => {
          try {
            const text = await navigator.clipboard.readText();
            const urls = extractUrls(text);
            if (urls.length) setNewTaskOpen(true, urls.join("\n"));
            else pushToast("剪贴板里没有可下载的链接", "error");
          } catch {
            pushToast("无法读取剪贴板，请使用 Ctrl+V", "error");
          }
        },
      },
    ];

    if (activeCount > 0) {
      list.push({
        id: "pause-all",
        label: "全部暂停",
        desc: `${activeCount} 个任务正在传输`,
        icon: Pause,
        keywords: "pause all 暂停 全部",
        group: "action",
        run: () => void backend.pauseAll(),
      });
    }
    if (pausedCount > 0) {
      list.push({
        id: "resume-all",
        label: "全部继续",
        desc: `${pausedCount} 个任务等待恢复`,
        icon: Play,
        keywords: "resume all 继续 恢复 全部",
        group: "action",
        run: () => void backend.resumeAll(),
      });
    }
    list.push(
      {
        id: "settings",
        label: "打开设置",
        desc: "下载目录、连接数、yt-dlp、外观",
        icon: Settings,
        keywords: "settings 设置 配置 偏好",
        group: "action",
        run: () => setView("settings"),
      },
      {
        id: "open-dir",
        label: "打开下载目录",
        desc: settings.saveDir,
        icon: FolderOpen,
        keywords: "open folder 打开 目录 下载文件夹",
        group: "action",
        run: () => void backend.openPath(settings.saveDir),
      },
      {
        id: "theme",
        label: "切换主题",
        desc: theme === "dark" ? "当前为深色，切换到浅色" : theme === "light" ? "当前为浅色，切换到跟随系统" : "当前跟随系统，切换到深色",
        icon: SunMoon,
        keywords: "theme dark light 主题 深色 浅色 外观",
        group: "action",
        run: () => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark"),
      },
      {
        id: "media",
        label: "只看视频任务",
        desc: "筛选 yt-dlp 视频下载",
        icon: Film,
        keywords: "video media filter 视频 筛选",
        group: "action",
        run: () => {
          setView("tasks");
          setFilter("media");
        },
      },
    );

    if (completedCount > 0) {
      list.push({
        id: "clear-completed",
        label: "清空已完成任务",
        desc: `${completedCount} 个记录，本地文件会保留`,
        icon: Trash2,
        keywords: "clear completed 清理 已完成",
        group: "action",
        run: async () => {
          const done = tasks.filter((t) => t.status === "completed");
          for (const task of done) {
            await backend.remove(task.id, false);
          }
          pushToast(`已清理 ${done.length} 条完成记录`, "success");
        },
      });
    }

    return list;
  }, [
    activeCount,
    pausedCount,
    completedCount,
    settings.saveDir,
    theme,
    tasks,
    setNewTaskOpen,
    setView,
    setFilter,
    setTheme,
    pushToast,
  ]);

  const taskItems = useMemo<CommandItem[]>(() => {
    const q = query.trim().toLowerCase();
    const sorted = sortTasks(tasks, "recent");
    return sorted
      .filter((task) => {
        if (!q) return task.status === "downloading" || task.status === "paused" || task.status === "failed";
        return (
          task.filename.toLowerCase().includes(q) ||
          task.domain.toLowerCase().includes(q) ||
          task.url.toLowerCase().includes(q)
        );
      })
      .slice(0, q ? 6 : 4)
      .map((task) => ({
        id: `task-${task.id}`,
        label: task.filename,
        desc: `${task.domain} · ${statusLabelMaybe(task.status)}`,
        icon: task.kind === "media" ? Film : ArrowDownToLine,
        keywords: `${task.filename} ${task.domain}`,
        group: "task" as const,
        task,
        run: () => {
          setView("tasks");
          select(task.id);
        },
      }));
  }, [query, tasks, setView, select]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchedActions = q
      ? actions.filter((item) =>
          `${item.label} ${item.desc ?? ""} ${item.keywords}`.toLowerCase().includes(q),
        )
      : actions;
    return [...matchedActions, ...taskItems];
  }, [actions, taskItems, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const execute = (item: CommandItem | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  return (
    <div className="modal-backdrop command-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <div ref={paletteRef} className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="command-input">
          <Search size={16} className="command-search-icon" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                execute(items[index]);
              } else if (event.key === "Escape") {
                close();
              }
            }}
            placeholder="搜索命令或任务…"
            spellCheck={false}
          />
          <kbd className="command-esc">ESC</kbd>
        </div>

        <div className="command-results">
          {items.length === 0 && (
            <div className="command-empty">没有匹配的命令或任务</div>
          )}
          {items.map((item, itemIndex) => {
            const Icon = item.icon;
            const showDividerBefore = item.group === "task" && itemIndex > 0 && items[itemIndex - 1]?.group === "action";
            return (
              <div key={item.id}>
                {showDividerBefore && <div className="command-divider">最近任务</div>}
                <button
                  className={cx("command-item", itemIndex === index && "active")}
                  onMouseEnter={() => setIndex(itemIndex)}
                  onClick={() => execute(item)}
                >
                  <span className={cx("command-item-icon", item.group === "task" && "task")}>
                    <Icon size={15} />
                  </span>
                  <span className="command-item-text">
                    <span className="command-item-label">{item.label}</span>
                    {item.desc && <span className="command-item-desc">{item.desc}</span>}
                  </span>
                  {item.group === "task" && item.task && (
                    <span className={cx("command-status", `status-${item.task.status}`)}>
                      {statusLabelMaybe(item.task.status)}
                    </span>
                  )}
                  {itemIndex === index && (
                    <span className="command-enter">
                      <CornerDownLeft size={12} />
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="command-footer">
          <span>
            <kbd>↑</kbd><kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 执行
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
          {theme === "system" && (
            <span className="command-theme-hint">
              <CheckCircle2 size={11} /> 跟随系统
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
