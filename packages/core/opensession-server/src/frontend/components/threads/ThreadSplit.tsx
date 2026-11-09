import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import { PANEL_RESIZE } from "../../lib/session-panel-classes";
import {
  closeThreadPane,
  registerThreadSplitHost,
  useThreadPaneStack,
} from "../../lib/thread-view";
import type { ReplyComposerCatalog } from "../SessionReplyComposer";
import { ThreadPane } from "./ThreadPane";

const WIDTH_KEY = "opensession-thread-split-width";
const MIN_SHARE = 0.25;
const MAX_SHARE = 0.7;
const DEFAULT_SHARE = 0.46;

interface SplitStyle extends CSSProperties {
  "--thread-w": string;
}

function storedShare(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return value >= MIN_SHARE && value <= MAX_SHARE ? value : DEFAULT_SHARE;
  } catch {
    return DEFAULT_SHARE;
  }
}

/**
 * The thread a conversation has open, as a column split off the right of the
 * conversation in the main pane (a vertical split), so both read side by
 * side at full height. Nested threads stack inside it (ThreadPane). Desktop
 * only: on a phone a thread opens as its own page.
 */
export function ThreadSplit({
  rootId,
  onOpenSession,
  catalog,
}: {
  rootId: string;
  onOpenSession: (id: string) => void;
  /** What the thread's composer needs (the conversation's own). */
  catalog: ReplyComposerCatalog;
}) {
  const phone = useIsPhone();
  useEffect(
    () => (phone ? undefined : registerThreadSplitHost(rootId)),
    [phone, rootId],
  );
  const stack = useThreadPaneStack(rootId);
  const [share, setShare] = useState(storedShare);
  const columnRef = useRef<HTMLElement | null>(null);
  const threadId = stack.at(-1);
  if (phone || !threadId) return null;

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const row = columnRef.current?.parentElement?.getBoundingClientRect();
    if (!row) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-panel");
    let next = share;
    const move = (e: PointerEvent) => {
      next = Math.min(
        MAX_SHARE,
        Math.max(MIN_SHARE, (row.right - e.clientX) / row.width),
      );
      setShare(next);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing-panel");
      try {
        localStorage.setItem(WIDTH_KEY, String(next));
      } catch {}
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const style: SplitStyle = { "--thread-w": `${share * 100}%` };
  return (
    <section
      ref={columnRef}
      aria-label="Thread"
      style={style}
      className="thread-split relative flex min-h-0 w-[var(--thread-w)] min-w-[360px] shrink-0 flex-col border-l border-divider bg-bg"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize thread"
        className={PANEL_RESIZE}
        onPointerDown={startResize}
        onDoubleClick={() => {
          setShare(DEFAULT_SHARE);
          try {
            localStorage.removeItem(WIDTH_KEY);
          } catch {}
        }}
      />
      <ThreadPane
        key={threadId}
        rootId={rootId}
        threadId={threadId}
        trail={stack.slice(0, -1)}
        onBack={(depth) => closeThreadPane(rootId, depth)}
        onOpenSession={onOpenSession}
        catalog={catalog}
      />
    </section>
  );
}
