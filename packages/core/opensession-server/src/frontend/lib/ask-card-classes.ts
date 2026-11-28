/** Visual shell and choice rows for the live AskUserQuestion card. */

export const ASK_CARD_SHELL =
  "mx-auto mb-6 mt-2 flex w-full max-w-[var(--session-col)] flex-col gap-5 rounded-xl bg-raised p-4 [corner-shape:var(--cs)]";

export const ASK_CHOICE_ROW_BASE =
  "group relative flex min-h-11 w-full select-none items-start gap-3 rounded-control bg-control px-3 py-2.5 text-left [corner-shape:var(--cs)]";

export const ASK_CHOICE_ROW = `${ASK_CHOICE_ROW_BASE} cursor-pointer transition-[background-color] hover:bg-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-ink`;
