import { useEffect, useState, type RefObject } from "react";
import type { TranscriptEntry } from "../lib/types";
import { IconArrowUp } from "./icons";
import {
  pickStickyPromptId,
  summarizeUserPrompt,
  type MeasuredUserPrompt,
} from "../lib/sticky-active-prompt";

interface StickyActivePromptProps {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly entries: readonly TranscriptEntry[];
  readonly sessionId: string;
}

/**
 * Quiet floating header pinned at the top of the transcript viewport when the
 * reader has scrolled deep into a long assistant turn, showing the user prompt
 * that started the turn with one-click jump back.
 */
export function StickyActivePrompt({
  containerRef,
  entries,
  sessionId,
}: StickyActivePromptProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const promptById = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "user" || !entry.id) continue;
    const text = summarizeUserPrompt(entry.content || "");
    if (text) promptById.set(entry.id, text);
  }

  useEffect(() => {
    setActiveId(null);
  }, [sessionId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;

    const measure = () => {
      raf = 0;
      const containerRect = el.getBoundingClientRect();
      const nodes = el.querySelectorAll<HTMLElement>(".msg-user[data-eid]");
      const prompts: MeasuredUserPrompt[] = [];
      for (const node of Array.from(nodes)) {
        const id = node.dataset.eid;
        if (!id) continue;
        const rect = node.getBoundingClientRect();
        prompts.push({ id, top: rect.top, bottom: rect.bottom });
      }
      const nextId = pickStickyPromptId({
        scrollTop: el.scrollTop,
        containerTop: containerRect.top,
        containerBottom: containerRect.bottom,
        prompts,
      });
      setActiveId((prev) => (prev === nextId ? prev : nextId));
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(measure);
    };

    schedule();
    el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [containerRef, entries.length, sessionId]);

  const text = activeId ? promptById.get(activeId) : undefined;
  if (!activeId || !text) return null;

  const jumpToPrompt = () => {
    const el = containerRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(
      `.msg-user[data-eid="${CSS.escape(activeId)}"]`,
    );
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-6 phone:hidden">
      <button
        type="button"
        onClick={jumpToPrompt}
        title={text}
        className="pointer-events-auto flex max-w-[min(720px,calc(100%-32px))] items-center gap-2 rounded-full border border-border/80 bg-panel/90 px-3 py-1.5 text-left text-meta text-dim shadow-sm backdrop-blur-md transition-colors hover:border-border-strong hover:text-fg"
      >
        <IconArrowUp size={12} className="shrink-0 text-faint" />
        <span className="truncate">{text}</span>
      </button>
    </div>
  );
}
