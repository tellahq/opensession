import { useState } from "react";
import { AGENT_NAME } from "../lib/brand";
import { renderMarkdown } from "../lib/markdown";
import type { AskQuestion } from "../lib/types";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { IconCheck } from "./icons";

interface Props {
  questions: AskQuestion[];
  onAnswer: (answers: Record<string, string>) => void;
}

/**
 * Interactive AskUserQuestion card — the agent is waiting on these answers.
 *
 * Surfaces: one raised card on the transcript — no outline of its own, the
 * surface step is the edge — with the choices as control-surface rows on top
 * of it. Deliberately two surfaces, not the three nested greys it used to wear
 * (card → section → row), which read as boxes-in-boxes.
 *
 * Selection is NEUTRAL, not accent: the accent is red here, and filling a
 * chosen row with it read as an error/warning rather than a pick. Same reason
 * the composer keeps its resting border on focus (see the .composer adapter).
 * It also doesn't tint the row at all — the filled indicator carries it, with
 * the hairline stepping up. The indicator is a circle for single-select and a
 * rounded square for multi-select, so the shape says how many answers are
 * allowed.
 */
export function AskCard({ questions, onAnswer }: Props) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  function toggle(q: AskQuestion, label: string) {
    setSelected((prev) => {
      const current = prev[q.question] || [];
      if (q.multiSelect) {
        return {
          ...prev,
          [q.question]: current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label],
        };
      }
      return { ...prev, [q.question]: [label] };
    });
  }

  function answerFor(q: AskQuestion): string | null {
    const custom = (other[q.question] || "").trim();
    const picks = selected[q.question] || [];
    const parts = [...picks, ...(custom ? [custom] : [])];
    return parts.length > 0 ? parts.join(", ") : null;
  }

  const complete = questions.every((q) => answerFor(q) !== null);

  function submit() {
    if (!complete || submitted) return;
    setSubmitted(true);
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = answerFor(q)!;
    onAnswer(answers);
  }

  return (
    <div className="mx-auto mb-6 mt-2 flex w-full max-w-[var(--chat-col)] flex-col gap-5 rounded-[calc(20px*var(--rf))] bg-raised p-4 [corner-shape:var(--cs)]">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-green shadow-[0_0_0_3px_var(--green-soft)]"
        />
        <span className="text-label font-semibold text-dim">
          {AGENT_NAME} needs input
        </span>
      </div>

      {questions.map((q) => (
        <section key={q.question} className="flex flex-col gap-3">
          {(q.header || q.multiSelect) && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {q.header && (
                <span className="text-label font-semibold text-faint">{q.header}</span>
              )}
              {q.multiSelect && (
                <span className="text-meta text-faint">Select all that apply</span>
              )}
            </div>
          )}
          {/* The question is prose, not a title: it is often several sentences,
              and setting it semibold turned whole paragraphs bold. Body weight
              on the transcript's own 14px/24px rhythm — the raised card and the
              "needs input" label already mark it as the thing being asked. */}
          <div
            className="markdown text-body leading-6 text-fg [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(q.question) }}
          />
          {q.options?.length ? (
            <div
              aria-label={q.header || "Answer options"}
              className="flex flex-col gap-1.5"
              role="group"
            >
              {q.options.map((opt) => {
                const active = (selected[q.question] || []).includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    aria-pressed={active}
                    // No hairline: the row's own surface against the card is the
                    // edge. And a pick doesn't tint the row — the filled
                    // indicator says it. Washing the row grey made the chosen
                    // option look dimmed, not chosen, and collided with the
                    // hover wash on its neighbours.
                    className="focus-ring group flex min-h-11 w-full items-start gap-3 rounded-[calc(12px*var(--rf))] bg-control px-3 py-2.5 text-left transition-[background-color] hover:bg-hover [corner-shape:var(--cs)] disabled:opacity-60"
                    onClick={() => toggle(q, opt.label)}
                    disabled={submitted}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-control-label font-semibold leading-5 text-fg">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="mt-0.5 block text-supporting leading-[1.45] text-dim">
                          {opt.description}
                        </span>
                      )}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-px flex h-5 w-5 shrink-0 items-center justify-center border transition-[background-color,border-color,color]",
                        q.multiSelect
                          ? "rounded-[calc(6px*var(--rf))] [corner-shape:var(--cs)]"
                          : "rounded-full",
                        active
                          ? "border-transparent bg-fg text-bg"
                          : "border-line-strong text-transparent",
                      )}
                    >
                      <IconCheck size={20} />
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <input
            aria-label={q.options?.length ? "Custom answer" : "Answer"}
            /* border-0 is load-bearing, not tidying: this app deliberately
               doesn't ship Tailwind's Preflight (see styles/tailwind.css), so
               an <input> with no border utility keeps the UA's 2px inset
               border — the dark outline this field used to wear. Any borderless
               input here has to zero it explicitly.

               No ring on focus either — same call the composer makes: it read
               as an error state on a field you're simply typing in, and the
               caret is affordance enough. */
            className="h-11 w-full rounded-[calc(12px*var(--rf))] border-0 bg-control px-3 text-base text-fg outline-none placeholder:text-faint disabled:opacity-60 sm:text-control-label [corner-shape:var(--cs)]"
            placeholder={
              q.options?.length ? "Or type your own answer…" : "Type your answer…"
            }
            value={other[q.question] || ""}
            onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={submitted}
          />
        </section>
      ))}

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="lg"
          onClick={submit}
          disabled={!complete || submitted}
        >
          {submitted ? "Sent" : "Answer"}
        </Button>
      </div>
    </div>
  );
}
