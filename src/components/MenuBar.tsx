import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { backend } from "../lib/backend";
import type { SortKey } from "../lib/types";

type MenuId = "tasks" | "file" | "downloads" | "view" | "help";

interface MenuEntry {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  sep?: boolean;
  onClick?: () => void;
}

export function MenuBar() {
  const tasks = useStore((s) => s.tasks);
  const selectedId = useStore((s) => s.selectedId);
  const focusedId = useStore((s) => s.focusedId);
  const select = useStore((s) => s.select);
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const sort = useStore((s) => s.sort);
  const setSort = useStore((s) => s.setSort);
  const setQuery = useStore((s) => s.setQuery);
  const setView = useStore((s) => s.setView);
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen);
  const setCommandOpen = useStore((s) => s.setCommandOpen);
  const pushToast = useStore((s) => s.pushToast);

  const [open, setOpen] = useState<MenuId | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const targetId = selectedId ?? focusedId;
  const targetTask = targetId ? tasks.find((t) => t.id === targetId) ?? null : null;
  const activeCount = tasks.filter(
    (t) => t.status === "downloading" || t.status === "connecting" || t.status === "queued",
  ).length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;

  const run = (fn: () => void | Promise<void>) => {
    setOpen(null);
    void fn();
  };

  const setSortBy = (key: SortKey) => {
    setView("tasks");
    setSort(key);
  };

  const menus: Array<{ id: MenuId; label: string; items: MenuEntry[] }> = [
    {
      id: "tasks",
      label: "任务",
      items: [
        { label: "添加新下载…", shortcut: "Ctrl+N", onClick: () => setNewTaskOpen(true) },
        { label: "打开命令面板…", shortcut: "Ctrl+K", onClick: () => setCommandOpen(true) },
        { sep: true },
        { label: "返回下载列表", onClick: () => setView("tasks") },
      ],
    },
    {
      id: "file",
      label: "文件",
      items: [
        {
          label: "打开所选文件",
          disabled: !targetTask || targetTask.status !== "completed",
          onClick: async () => {
            if (targetTask) await backend.openFile(targetTask.savePath);
          },
        },
        {
          label: "打开所在文件夹",
          disabled: !targetTask,
          onClick: async () => {
            if (targetTask) await backend.openPath(targetTask.savePath);
          },
        },
        { sep: true },
        {
          label: "移出所选任务（保留文件）",
          disabled: !targetTask,
          onClick: async () => {
            if (!targetTask) return;
            await backend.remove(targetTask.id, false);
            if (selectedId === targetTask.id) select(null);
            pushToast(`已移出：${targetTask.filename}`, "info");
          },
        },
        {
          label: "清理全部已完成记录",
          disabled: completedCount === 0,
          danger: true,
          onClick: async () => {
            const ids = tasks.filter((t) => t.status === "completed").map((t) => t.id);
            for (const id of ids) await backend.remove(id, false);
            pushToast(`已清理 ${ids.length} 条已完成记录`, "info");
          },
        },
      ],
    },
    {
      id: "downloads",
      label: "下载",
      items: [
        {
          label: "继续所选任务",
          disabled: !targetTask || (targetTask.status !== "paused" && targetTask.status !== "failed"),
          onClick: async () => {
            if (!targetTask) return;
            if (targetTask.status === "failed") await backend.retry(targetTask.id);
            else await backend.resume(targetTask.id);
          },
        },
        {
          label: "暂停所选任务",
          disabled:
            !targetTask ||
            (targetTask.status !== "downloading" &&
              targetTask.status !== "connecting" &&
              targetTask.status !== "queued"),
          onClick: async () => {
            if (targetTask) await backend.pause(targetTask.id);
          },
        },
        { sep: true },
        {
          label: "全部继续",
          onClick: async () => {
            await backend.resumeAll();
            pushToast("已恢复全部可继续任务", "success");
          },
        },
        {
          label: "全部停止",
          disabled: activeCount === 0,
          onClick: async () => {
            await backend.pauseAll();
            pushToast("已暂停全部任务", "info");
          },
        },
        { sep: true },
        { label: "选项与队列设置…", onClick: () => setView("settings") },
      ],
    },
    {
      id: "view",
      label: "视图",
      items: [
        {
          label: `${viewMode === "table" ? "✓ " : ""}多列网格表（IDM 经典）`,
          onClick: () => {
            setView("tasks");
            setViewMode("table");
          },
        },
        {
          label: `${viewMode === "card" ? "✓ " : ""}卡片列表视图`,
          onClick: () => {
            setView("tasks");
            setViewMode("card");
          },
        },
        { sep: true },
        { label: `${sort === "recent" ? "✓ " : ""}按默认分组排序`, onClick: () => setSortBy("recent") },
        { label: `${sort === "name" ? "✓ " : ""}按文件名排序`, onClick: () => setSortBy("name") },
        { label: `${sort === "size" ? "✓ " : ""}按大小排序`, onClick: () => setSortBy("size") },
        { label: `${sort === "rate" ? "✓ " : ""}按速率排序`, onClick: () => setSortBy("rate") },
        { label: `${sort === "added" ? "✓ " : ""}按添加时间排序`, onClick: () => setSortBy("added") },
        { sep: true },
        {
          label: "显示 / 隐藏桌面拖拽悬浮球",
          onClick: async () => {
            try {
              const opened = await backend.toggleDropTarget();
              pushToast(opened ? "已开启桌面置顶拖拽悬浮球" : "已隐藏桌面拖拽悬浮球", "info");
            } catch (err) {
              pushToast(String(err), "error");
            }
          },
        },
        { sep: true },
        { label: "清空搜索过滤", onClick: () => setQuery("") },
      ],
    },
    {
      id: "help",
      label: "帮助",
      items: [
        { label: "检查更新与工具状态…", onClick: () => setView("settings") },
        { label: "关于 FluxDL", onClick: () => setView("settings") },
      ],
    },
  ];

  return (
    <div className="idm-menubar" ref={barRef} role="menubar" aria-label="主菜单栏">
      {menus.map((menu) => (
        <div className="idm-menu-wrap" key={menu.id}>
          <button
            type="button"
            role="menuitem"
            aria-expanded={open === menu.id}
            className={`idm-menu-trigger${open === menu.id ? " is-open" : ""}`}
            onClick={() => setOpen(open === menu.id ? null : menu.id)}
            onMouseEnter={() => {
              if (open !== null) setOpen(menu.id);
            }}
          >
            {menu.label}
          </button>
          {open === menu.id && (
            <div className="idm-menu-popup" role="menu">
              {menu.items.map((item, idx) =>
                item.sep ? (
                  <div className="idm-menu-sep" key={`sep-${idx}`} role="separator" />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    className={`idm-menu-item${item.danger ? " danger" : ""}`}
                    onClick={() => item.onClick && run(item.onClick)}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className="idm-menu-kbd">{item.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
