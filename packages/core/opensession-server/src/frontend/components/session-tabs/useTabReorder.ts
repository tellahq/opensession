import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

type Point = { x: number; y: number };

type Options = {
  enabled: boolean;
  editingId: string | null;
  onReorder: (ids: string[]) => void;
  onSplitDrag?: (id: string | null, point?: Point) => void;
  onSplitDrop?: (id: string, point: Point) => boolean;
};

/**
 * Owns the interaction state for the tab strip's desktop drag and drop.
 * SessionTabs only needs the draft order, the insertion marker and the props
 * shared by each Reorder.Item.
 */
export function useTabReorder({
  enabled,
  editingId,
  onReorder,
  onSplitDrag,
  onSplitDrop,
}: Options) {
  const [draftOrder, setDraftOrder] = useState<string[] | null>(null);
  const draftOrderRef = useRef<string[] | null>(null);
  const justDragged = useRef(false);
  const dragPoint = useRef<Point | null>(null);
  const stopPointerTracking = useRef<(() => void) | null>(null);
  const splitDragFrame = useRef(0);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const [dropSlot, setDropSlot] = useState<{
    key: string;
    left: number;
    width: number;
  } | null>(null);
  const dragMetrics = useRef<{
    widths: Map<string, number>;
    gap: number;
    key: string;
  } | null>(null);

  function cancelSplitDragFrame() {
    if (!splitDragFrame.current) return;
    cancelAnimationFrame(splitDragFrame.current);
    splitDragFrame.current = 0;
  }

  function placeDropSlot(keys: string[]) {
    const metrics = dragMetrics.current;
    if (!metrics) return;
    const index = keys.indexOf(metrics.key);
    if (index < 0) return setDropSlot(null);
    let left = 0;
    for (let i = 0; i < index; i++) {
      left += (metrics.widths.get(keys[i]) ?? 0) + metrics.gap;
    }
    setDropSlot({
      key: metrics.key,
      left,
      width: metrics.widths.get(metrics.key) ?? 0,
    });
  }

  function beginDrag(key: string) {
    const group = groupRef.current;
    if (!group) return;
    // Layout boxes stay stable while Motion scales the dragged item.
    const items = [...group.children].filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && !!element.dataset.tabKey,
    );
    const widths = new Map(
      items.map(
        (element) => [element.dataset.tabKey!, element.offsetWidth] as const,
      ),
    );
    const gap =
      items.length > 1
        ? Math.max(
            0,
            items[1].offsetLeft - (items[0].offsetLeft + items[0].offsetWidth),
          )
        : 0;
    dragMetrics.current = { widths, gap, key };
    placeDropSlot(items.map((element) => element.dataset.tabKey!));
  }

  function clearDrag() {
    dragMetrics.current = null;
    setDropSlot(null);
  }

  function swallowTrailingClick() {
    justDragged.current = true;
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
  }

  function finishReorder() {
    swallowTrailingClick();
    const order = draftOrderRef.current;
    draftOrderRef.current = null;
    setDraftOrder(null);
    clearDrag();
    if (order) onReorder(order);
  }

  function handleReorder(keys: string[]) {
    draftOrderRef.current = keys;
    setDraftOrder(keys);
    placeDropSlot(keys);
  }

  function trackPointer(id: string, event: ReactPointerEvent) {
    stopPointerTracking.current?.();
    dragPoint.current = { x: event.clientX, y: event.clientY };
    let sent: Point | null = null;
    const flush = () => {
      splitDragFrame.current = 0;
      const point = dragPoint.current;
      if (!point || (sent && sent.x === point.x && sent.y === point.y)) return;
      sent = point;
      onSplitDrag?.(id, point);
    };
    const move = (pointer: PointerEvent) => {
      dragPoint.current = { x: pointer.clientX, y: pointer.clientY };
      if (!splitDragFrame.current) {
        splitDragFrame.current = requestAnimationFrame(flush);
      }
    };
    const finish = () => {
      cancelSplitDragFrame();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      stopPointerTracking.current = null;
      onSplitDrag?.(null);
    };
    stopPointerTracking.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  useEffect(() => () => stopPointerTracking.current?.(), []);

  function handleItemPointerDown(key: string, event: ReactPointerEvent) {
    if (enabled && editingId !== key) trackPointer(key, event);
  }

  function handleItemDragStart(key: string) {
    beginDrag(key);
  }

  function handleItemDragEnd(key: string) {
    cancelSplitDragFrame();
    onSplitDrag?.(null);
    const point = dragPoint.current;
    dragPoint.current = null;
    if (point && onSplitDrop?.(key, point)) {
      draftOrderRef.current = null;
      setDraftOrder(null);
      clearDrag();
      swallowTrailingClick();
      return;
    }
    finishReorder();
  }

  function handleItemClickCapture(event: MouseEvent) {
    if (!justDragged.current) return;
    event.stopPropagation();
    event.preventDefault();
  }

  return {
    draftOrder,
    dropSlot,
    groupRef,
    handleReorder,
    handleItemPointerDown,
    handleItemDragStart,
    handleItemDragEnd,
    handleItemClickCapture,
  };
}
