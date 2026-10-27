/**
 * The phone review canvas' floating action pill (Files page): a dock that
 * spans the bottom edge without catching taps, and the raised pill inside it
 * holding the file count, "Finish review" and the merge action. The dock clears the home
 * indicator; the diff's scroller reserves the same height underneath so its
 * last line can scroll out from behind the pill.
 */
export const PHONE_REVIEW_PILL_DOCK =
  "pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-3 pb-[max(12px,env(safe-area-inset-bottom))]";

export const PHONE_REVIEW_PILL =
  "pointer-events-auto flex max-w-full items-center gap-1 rounded-[999px] bg-raised p-1 smooth-shadow-ring-md";
