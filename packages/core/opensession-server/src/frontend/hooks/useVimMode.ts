// Binds the pure VimEngine (lib/vim) to the composer's controlled textarea.
// The engine never touches the DOM: this hook feeds it keydowns with the
// current { text, selection }, routes text changes through the parent's
// onChange (keeping React the owner of the value) and applies the returned
// selection after the commit. Toggling the pref off mid-session drops the
// engine — and any half-typed command state — back to plain typing.

import { useEffect, useRef, useState } from "react";
import { VimEngine, verticalCaretTarget, type VimMode } from "../lib/vim";

const VIM_ARROW_KEYS = new Map([
  ["ArrowLeft", "h"],
  ["ArrowRight", "l"],
  ["ArrowUp", "k"],
  ["ArrowDown", "j"],
]);

export interface VimModeController {
  mode: VimMode;
  /** Returns true when the key was consumed (caller must not process it further). */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /**
   * Software-press a key by name ("Escape", "ArrowLeft", "Tab") — the phone
   * key bar, where the on-screen keyboard has no such keys. Keys the engine
   * doesn't consume are emulated on the textarea (arrows move the caret, Tab
   * indents), so the bar works in insert mode too.
   */
  injectKey: (key: string) => void;
}

export function useVimMode({
  enabled,
  textareaRef,
  value,
  onChange,
}: {
  enabled: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
}): VimModeController {
  const engineRef = useRef<VimEngine | null>(null);
  const [mode, setMode] = useState<VimMode>("insert");

  useEffect(() => {
    if (!enabled) {
      engineRef.current = null;
      setMode("insert");
    }
  }, [enabled]);

  function applySelection(start: number, end: number) {
    // After React commits the (possibly new) value — setting it before the
    // value lands would clamp against the old text.
    queueMicrotask(() => {
      textareaRef.current?.setSelectionRange(start, end);
    });
  }

  function feed(key: string, e?: React.KeyboardEvent): boolean {
    const el = textareaRef.current;
    if (!el) return false;
    if (!engineRef.current) engineRef.current = new VimEngine();
    const engine = engineRef.current;
    const res = engine.handleKey(
      e ?? {
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      { text: value, start: el.selectionStart, end: el.selectionEnd },
    );
    setMode(engine.mode);
    if (!res) return false;
    e?.preventDefault();
    if (res.text !== value) onChange(res.text);
    applySelection(res.start, res.end);
    return true;
  }

  function handleKeyDown(e: React.KeyboardEvent): boolean {
    if (!enabled) return false;
    return feed(e.key, e);
  }

  function injectKey(key: string) {
    if (!enabled) return;
    const el = textareaRef.current;
    if (!el) return;
    // Outside insert mode, arrows behave as their vim motions so visual-mode
    // selections extend instead of collapsing.
    const mapped =
      engineRef.current && engineRef.current.mode !== "insert"
        ? (VIM_ARROW_KEYS.get(key) ?? key)
        : key;
    if (feed(mapped)) return;
    // Not consumed — insert-mode emulation of the key's native behavior.
    const pos = el.selectionStart;
    switch (key) {
      case "ArrowLeft":
        applySelection(Math.max(0, pos - 1), Math.max(0, pos - 1));
        return;
      case "ArrowRight": {
        const p = Math.min(value.length, el.selectionEnd + 1);
        applySelection(p, p);
        return;
      }
      case "ArrowUp":
      case "ArrowDown": {
        const p = verticalCaretTarget(value, pos, key === "ArrowDown" ? 1 : -1);
        applySelection(p, p);
        return;
      }
      case "Tab": {
        const next = value.slice(0, pos) + "\t" + value.slice(el.selectionEnd);
        onChange(next);
        applySelection(pos + 1, pos + 1);
        return;
      }
    }
  }

  return { mode, handleKeyDown, injectKey };
}
