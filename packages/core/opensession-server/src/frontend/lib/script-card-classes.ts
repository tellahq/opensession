/** Visual shell of a script run card (ScriptRunsCard): the live ask card's
 *  surface, tighter, since several can stack. */
export const SCRIPT_CARD_SHELL =
  "mx-auto mb-3 mt-2 flex w-full max-w-[var(--session-col)] flex-col gap-3 rounded-xl bg-raised p-4 [corner-shape:var(--cs)]";

/** The log tail: a code well that follows its end. */
export const SCRIPT_OUTPUT =
  "m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-control bg-code-well p-3 font-mono text-meta leading-relaxed text-code-well-ink phone:max-h-56";
