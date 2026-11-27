import { useEffect, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { TranscriptEntry } from "../lib/types";
import { RAIL_GUTTER_CLASS } from "../lib/message-rail";
import { STICKY_PROMPT_PILL } from "../lib/session-viewer-classes";
import { duration, ease } from "../ui/motion";
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
 * The prompt a long turn answers, pinned at the top of the transcript once its
 * bubble has scrolled away. It sits where that bubble sat (right edge of the
 * reading column) in the same wash, and a click scrolls back to it.
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

  const jumpToPrompt = () => {
    const el = containerRef.current;
    if (!el || !activeId) return;
    const target = el.querySelector<HTMLElement>(
      `.msg-user[data-eid="${CSS.escape(activeId)}"]`,
    );
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Laid out like a transcript row (the scroller's side padding, the reading
  // column, the summary card's step) so the pill lands on the bubble's edge.
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-2 z-20 px-5 ${RAIL_GUTTER_CLASS} phone:hidden`}
    >
      <div className="mx-auto flex w-full max-w-[var(--session-col)] justify-end desktop:translate-x-[var(--ws-summary-step,0px)]">
        <AnimatePresence initial={false}>
          {activeId && text ? (
            <motion.button
              key="sticky-prompt"
              type="button"
              onClick={jumpToPrompt}
              title={text}
              aria-label={`Back to your message: ${text}`}
              className={STICKY_PROMPT_PILL}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ type: "tween", duration: duration.micro, ease }}
            >
              <span className="truncate">{text}</span>
            </motion.button>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
