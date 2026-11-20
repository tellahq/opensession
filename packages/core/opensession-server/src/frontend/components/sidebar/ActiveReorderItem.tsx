import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { Reorder, useDragControls } from "motion/react";
import type { ActiveRowDrag } from "../../hooks/useActiveRowDrag";
import {
  SIDEBAR_PIN_DRAG_ACTIVE,
  SIDEBAR_PIN_ENTRY,
  SIDEBAR_PIN_ENTRY_DRAGGING,
} from "../../lib/sidebar-classes";
import { cn } from "../../ui/cn";

/**
 * An Active section's draggable rows. It reads the in-flight drag from the
 * store itself, so each swap re-renders only these wrappers. The rows arrive
 * already rendered, and the same elements are reused while the drag runs.
 */
export function ActiveReorderGroup({
  gkey,
  drag,
  rows,
}: {
  gkey: string;
  drag: ActiveRowDrag;
  rows: { key: string; node: React.ReactNode }[];
}) {
  const { store } = drag;
  const { draft, dragKey } = useSyncExternalStore(
    store.subscribe,
    store.get,
    store.get,
  );
  let ordered = rows;
  if (draft?.gkey === gkey) {
    const index = new Map(draft.keys.map((key, i) => [key, i] as const));
    ordered = [...rows].sort(
      (a, b) => (index.get(a.key) ?? Infinity) - (index.get(b.key) ?? Infinity),
    );
  }
  return (
    <Reorder.Group
      as="div"
      axis="y"
      values={ordered.map((row) => row.key)}
      onReorder={(keys: string[]) => drag.onReorder(gkey, keys)}
    >
      {ordered.map((row) => (
        <ActiveReorderItem
          key={row.key}
          rowKey={row.key}
          drag={drag}
          dragKey={dragKey}
        >
          {row.node}
        </ActiveReorderItem>
      ))}
    </Reorder.Group>
  );
}

/**
 * One draggable row in an Active section. A mouse drags the whole row, as in
 * Pinned. A finger can't (the drag would steal the list's scroll), so a long
 * press lifts the row instead: the workspace controller calls the lift this
 * item registers, which starts Motion's drag from the press that began it.
 */
export function ActiveReorderItem({
  rowKey,
  drag,
  dragKey,
  children,
}: {
  rowKey: string;
  drag: ActiveRowDrag;
  dragKey: string | null;
  children: React.ReactNode;
}) {
  const controls = useDragControls();
  const press = useRef<PointerEvent | null>(null);
  const { registerLift } = drag;
  useEffect(
    () =>
      registerLift(rowKey, () => {
        if (!press.current) return false;
        controls.start(press.current);
        return true;
      }),
    [registerLift, rowKey, controls],
  );
  return (
    <Reorder.Item
      as="div"
      value={rowKey}
      dragListener={drag.pointerDrag}
      dragControls={controls}
      transition={{ duration: 0 }}
      onPointerDownCapture={(event: React.PointerEvent) => {
        press.current = event.nativeEvent;
      }}
      onDragStart={() => drag.onDragStart(rowKey)}
      onDragEnd={drag.onDragEnd}
      whileDrag={{ scale: 1.01 }}
      className={cn(
        SIDEBAR_PIN_ENTRY,
        dragKey && SIDEBAR_PIN_DRAG_ACTIVE,
        dragKey === rowKey && SIDEBAR_PIN_ENTRY_DRAGGING,
      )}
      onClickCapture={drag.onClickCapture}
    >
      {children}
    </Reorder.Item>
  );
}
