import { useCallback, useRef, useState } from "react";

export interface DragRowProps {
  draggable: boolean;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}

interface DragReorderOptions {
  enabled: boolean;
  onReorder: (dragId: string, overId: string) => void;
}

/**
 * HTML5 拖拽排序的共享逻辑：返回一组 props 摊到每个可拖拽行上。
 * 只处理「把 A 放到 B 的位置」这一件事，具体的顺序写入由调用方 onReorder 决定。
 * dragOverId 用于渲染插入指示线；dragId 是当前正在拖动的行。
 */
export function useDragReorder({ enabled, onReorder }: DragReorderOptions) {
  const dragId = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const rowProps = useCallback(
    (id: string): DragRowProps => ({
      draggable: enabled,
      onDragStart: (event: React.DragEvent) => {
        if (!enabled) return;
        dragId.current = id;
        setDraggingId(id);
        event.dataTransfer.effectAllowed = "move";
        // Firefox 需要设置数据才会触发 dragover；用任务 id 作为载荷。
        event.dataTransfer.setData("text/plain", id);
      },
      onDragOver: (event: React.DragEvent) => {
        if (!enabled || !dragId.current) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dragOverId !== id) setDragOverId(id);
      },
      onDrop: (event: React.DragEvent) => {
        if (!enabled) return;
        event.preventDefault();
        event.stopPropagation();
        const from = dragId.current ?? event.dataTransfer.getData("text/plain");
        if (from && from !== id) onReorder(from, id);
        dragId.current = null;
        setDraggingId(null);
        setDragOverId(null);
      },
      onDragEnd: () => {
        dragId.current = null;
        setDraggingId(null);
        setDragOverId(null);
      },
    }),
    [enabled, dragOverId, onReorder],
  );

  return { rowProps, dragOverId, draggingId };
}
