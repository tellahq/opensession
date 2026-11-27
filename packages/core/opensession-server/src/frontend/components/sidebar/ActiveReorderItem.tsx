import React, { useEffect, useRef } from "react";
import { Reorder, useDragControls } from "motion/react";
import type { ActiveRowDrag } from "../../hooks/useActiveRowDrag";
import { sidebarPinEntry } from "../../lib/sidebar-classes";
import { cn } from "../../ui/cn";

/**
 * One draggable row in an Active section. A mouse drags the whole row, as in
 * Pinned. A finger can't (the drag would steal the list's scroll), so a long
 * press lifts the row instead: the workspace controller calls the lift this
 * item registers, which starts Motion's drag from the press that began it.
 */
export function ActiveReorderItem({
  rowKey,
  drag,
  children,
}: {
  rowKey: string;
  drag: ActiveRowDrag;
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
      className={sidebarPinEntry({
        dragActive: !!drag.dragKey,
        dragging: drag.dragKey === rowKey,
      })}
      onClickCapture={drag.onClickCapture}
    >
      {children}
    </Reorder.Item>
  );
}
