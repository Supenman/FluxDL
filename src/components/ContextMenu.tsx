import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  id: string;
  label: string;
  /** 右侧提示，如快捷键 */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  /** 菜单左上角坐标（视口坐标） */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** 无障碍标签 */
  label: string;
}

/**
 * 通用上下文菜单：方向键上下移动、Enter/Space 执行、Esc 关闭、
 * 点击外部关闭、贴边时自动翻转避免溢出视口。
 */
export function ContextMenu({ x, y, items, onClose, label }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [active, setActive] = useState(0);

  // 贴边翻转：渲染后量一次尺寸，避免菜单跑出视口。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = x;
    let top = y;
    if (left + rect.width + margin > window.innerWidth) left = window.innerWidth - rect.width - margin;
    if (top + rect.height + margin > window.innerHeight) top = window.innerHeight - rect.height - margin;
    setPos({ left: Math.max(margin, left), top: Math.max(margin, top) });
  }, [x, y]);

  useEffect(() => {
    const el = ref.current;
    // 让菜单可被键盘操作，但不要抢走触发元素上已确立的焦点语义。
    el?.focus();

    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const enabled = items.filter((item) => !item.disabled);

  const move = (delta: number) => {
    if (!enabled.length) return;
    const currentId = items[active]?.id;
    let index = enabled.findIndex((item) => item.id === currentId);
    if (index < 0) index = 0;
    index = (index + delta + enabled.length) % enabled.length;
    setActive(items.findIndex((item) => item.id === enabled[index].id));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const item = items[active];
      if (item && !item.disabled) {
        onClose();
        item.onSelect();
      }
    }
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          className={[
            "context-menu-item",
            item.danger ? "is-danger" : "",
            index === active ? "is-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="menuitem"
          disabled={item.disabled}
          onMouseEnter={() => setActive(index)}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          <span className="context-menu-label">{item.label}</span>
          {item.hint && <span className="context-menu-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
