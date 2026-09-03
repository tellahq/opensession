import { isApple } from "./platform";

export type UndoHandle = {
  key: string;
  token: number;
};

type UndoEntry = UndoHandle & {
  run: () => void;
};

const entries: UndoEntry[] = [];
let nextToken = 1;

/** Keycaps shared by every visible Undo affordance. */
export const UNDO_SHORTCUT_KEYS = isApple ? ["⌘", "Z"] : ["Ctrl", "Z"];

/**
 * Put one reversible action at the top of the app-wide undo stack. Registering
 * the same key again replaces its stale callback, which is useful when several
 * mounted controls represent the same pending action.
 */
export function registerUndoAction(key: string, run: () => void): UndoHandle {
  const existing = entries.findIndex((entry) => entry.key === key);
  if (existing >= 0) entries.splice(existing, 1);
  const entry = { key, token: nextToken++, run };
  entries.push(entry);
  return { key: entry.key, token: entry.token };
}

/** Remove exactly the registration represented by this handle. */
export function clearUndoAction(
  handle: UndoHandle | null | undefined,
): boolean {
  if (!handle) return false;
  const index = entries.findIndex(
    (entry) => entry.key === handle.key && entry.token === handle.token,
  );
  if (index < 0) return false;
  entries.splice(index, 1);
  return true;
}

/** Run the newest reversible action. The entry is consumed before it runs. */
export function undoLatestAction(): boolean {
  const entry = entries.pop();
  if (!entry) return false;
  entry.run();
  return true;
}

export function hasUndoAction(): boolean {
  return entries.length > 0;
}

/** Keep native field history in charge while a person is editing text. */
export function isEditableUndoTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      "input, textarea, select, [contenteditable='true'], [contenteditable='']",
    )
  );
}

/** Command-Z on Apple platforms and Ctrl-Z elsewhere, without redo modifiers. */
export function isUndoShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "z" &&
    !event.altKey &&
    !event.shiftKey &&
    (isApple
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey)
  );
}
