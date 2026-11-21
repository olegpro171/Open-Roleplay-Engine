import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react';

export function moveListItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

type TouchReorder = {
  pointerId: number;
  source: number;
  handle: HTMLElement;
  list: HTMLDivElement;
  scroller: HTMLElement | null;
  startY: number;
  x: number;
  y: number;
  moving: boolean;
  frame: number | null;
};

function scrollableAncestor(list: HTMLElement) {
  for (let node = list.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

function containsPoint(rect: DOMRect, x: number, y: number) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function touchScrollStep(gesture: TouchReorder, scroller: HTMLElement) {
  const rect = scroller.getBoundingClientRect();
  if (!containsPoint(rect, gesture.x, gesture.y)) return 0;
  const edge = Math.min(48, rect.height / 4);
  const above = Math.max(rect.top, 0) + edge - gesture.y;
  const below = gesture.y - (Math.min(rect.bottom, window.innerHeight) - edge);
  if (above > 0) return -Math.ceil(above / 3);
  if (below > 0) return Math.ceil(below / 3);
  return 0;
}

export function useListReorder(move: (from: number, to: number) => void, enabled = true) {
  const list = useRef<HTMLDivElement>(null);
  const touch = useRef<TouchReorder | null>(null);
  const [touchSource, setTouchSource] = useState<number | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  useEffect(() => () => {
    const frame = touch.current?.frame;
    if (frame != null) cancelAnimationFrame(frame);
    touch.current = null;
  }, []);

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
  function drop(source: number, position: number) {
    move(source, position > source ? position - 1 : position);
  }
  function allowed(element: HTMLElement) {
    return enabled && !element.closest('fieldset:disabled');
  }
  function touchBoundary(gesture: TouchReorder) {
    const { list, x, y } = gesture;
    // The list can extend beneath a scroller's edge or overlaid editor controls.
    return list.contains(list.ownerDocument.elementFromPoint(x, y)) ? boundary(list, y) : null;
  }
  function followTouch(gesture: TouchReorder) {
    setGap(touchBoundary(gesture));
    const scroller = gesture.scroller;
    if (!scroller || gesture.frame !== null || !touchScrollStep(gesture, scroller)) return;
    gesture.frame = requestAnimationFrame(() => {
      gesture.frame = null;
      if (!gesture.handle.isConnected || !allowed(gesture.handle)) return;
      const top = scroller.scrollTop;
      scroller.scrollTop += touchScrollStep(gesture, scroller);
      if (top !== scroller.scrollTop) followTouch(gesture);
    });
  }
  function finishTouch(event: PointerEvent<HTMLElement>) {
    const gesture = touch.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    touch.current = null;
    setTouchSource(null);
    if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
    end();
    if (event.type !== 'pointerup' || !gesture.moving || !allowed(gesture.handle)) return;
    if (!gesture.list.children[gesture.source]?.contains(gesture.handle)) return;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    const position = touchBoundary(gesture);
    if (position !== null) drop(gesture.source, position);
  }
  return {
    handle(index: number, id: string) {
      return {
        'data-reorder-disabled': !enabled,
        draggable: enabled && touchSource !== index,
        onPointerDown(event: PointerEvent<HTMLElement>) {
          const handle = event.currentTarget;
          const container = list.current;
          if (event.pointerType !== 'touch' || !event.isPrimary || !container || touch.current || dragged !== null || !allowed(handle)) return;
          handle.setPointerCapture(event.pointerId);
          touch.current = {
            pointerId: event.pointerId, source: index, handle, list: container,
            scroller: scrollableAncestor(container), startY: event.clientY,
            x: event.clientX, y: event.clientY, moving: false, frame: null,
          };
          // Suppress native long-press dragging for the active touch pointer.
          setTouchSource(index);
        },
        onPointerMove(event: PointerEvent<HTMLElement>) {
          const gesture = touch.current;
          if (!gesture || gesture.pointerId !== event.pointerId || !allowed(gesture.handle)) return;
          if (!gesture.moving) {
            if (Math.abs(event.clientY - gesture.startY) < 6) return;
            gesture.moving = true;
            setDragged(gesture.source);
          }
          gesture.x = event.clientX;
          gesture.y = event.clientY;
          followTouch(gesture);
        },
        onPointerUp: finishTouch,
        onPointerCancel: finishTouch,
        onLostPointerCapture: finishTouch,
        onDragStart(event: DragEvent<HTMLElement>) {
          if (touch.current || !allowed(event.currentTarget)) { event.preventDefault(); return; }
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
      ref: list,
      onDragOver(event: DragEvent<HTMLDivElement>) {
        if (touch.current || dragged === null || !allowed(event.currentTarget)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setGap(boundary(event.currentTarget, event.clientY));
      },
      onDrop(event: DragEvent<HTMLDivElement>) {
        if (touch.current || dragged === null || !allowed(event.currentTarget)) return;
        event.preventDefault();
        drop(dragged, boundary(event.currentTarget, event.clientY));
        end();
      },
      onDragLeave(event: DragEvent<HTMLDivElement>) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setGap(null);
      },
    },
  };
}
