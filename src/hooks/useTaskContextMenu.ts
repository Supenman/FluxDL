import { useCallback, useState } from "react";
import type { Task } from "../lib/types";
import { buildTaskMenu } from "../lib/taskMenu";
import { useStore } from "../store";

interface MenuState {
  x: number;
  y: number;
  task: Task;
}

/**
 * 任务右键菜单的共享状态：卡片行与数据表行都调用 openMenu，
 * 由调用方在最外层渲染 <ContextMenu/>（避免每行一个 DOM 节点）。
 */
export function useTaskContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const select = useStore((s) => s.select);
  const selectedId = useStore((s) => s.selectedId);
  const setProgressId = useStore((s) => s.setProgressId);
  const pushToast = useStore((s) => s.pushToast);

  const openMenu = useCallback((event: React.MouseEvent, task: Task) => {
    event.preventDefault();
    event.stopPropagation();
    // 这里刻意不调用 select(task.id)：selectedId 会直接驱动详情抽屉，
    // 右键就会弹出抽屉并用全屏遮罩压暗菜单。右键只负责「瞄准」哪个任务，
    // 「查看详情」是菜单里的一项显式动作。
    setMenu({ x: event.clientX, y: event.clientY, task });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  const items = menu
    ? buildTaskMenu({
        task: menu.task,
        pushToast,
        onSelect: select,
        selected: selectedId === menu.task.id,
        onOpenProgress: setProgressId,
        onOpenDetail: (id) => select(id),
      })
    : [];

  return { menu, openMenu, close, items };
}
