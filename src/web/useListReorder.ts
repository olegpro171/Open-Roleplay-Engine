import { useState, type DragEvent } from 'react';

export function moveListItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

export function useListReorder(move: (from: number, to: number) => void, enabled = true) {
  const [dragged, setDragged] = useState<number | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  function boundary(element: HTMLElement, y: number) {
    const rows = Array.from(element.children);
    const index = rows.findIndex(row => {
      const rect = row.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    return index < 0 ? rows.length : index;
  }
  function end() {
    setDragged(null);
    setGap(null);
  }
  function allowed(element: HTMLElement) {
    return enabled && !element.closest('fieldset:disabled');
  }
  return {
    handle(index: number, id: string) {
      return {
        draggable: enabled,
        onDragStart(event: DragEvent<HTMLElement>) {
          if (!allowed(event.currentTarget)) { event.preventDefault(); return; }
          event.dataTransfer.setData('text/plain', id);
          event.dataTransfer.effectAllowed = 'move';
          setDragged(index);
        },
        onDragEnd: end,
      };
    },
    rowClass(index: number, length: number) {
      return `${dragged === index ? ' dragging' : ''}${gap === index ? ' drop-before' : ''}${index === length - 1 && gap === length ? ' drop-after' : ''}`;
    },
    list: {
      onDragOver(event: DragEvent<HTMLDivElement>) {
        if (dragged === null || !allowed(event.currentTarget)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setGap(boundary(event.currentTarget, event.clientY));
      },
      onDrop(event: DragEvent<HTMLDivElement>) {
        if (dragged === null || !allowed(event.currentTarget)) return;
        event.preventDefault();
        const position = boundary(event.currentTarget, event.clientY);
        move(dragged, position > dragged ? position - 1 : position);
        end();
      },
      onDragLeave(event: DragEvent<HTMLDivElement>) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setGap(null);
      },
    },
  };
}
