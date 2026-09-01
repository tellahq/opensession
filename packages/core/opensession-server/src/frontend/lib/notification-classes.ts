import { utilityClassName } from "../ui/cn";
/**
 * Screen-level notification lanes.
 *
 * Live status stays near the app header. Toast receipts sit above the composer
 * at every width. Persistent prompts use the bottom-left desktop shelf; their
 * phone equivalents belong in the app header so they remain visible without
 * covering controls.
 */
export const TRANSIENT_NOTICE_LANE =
  utilityClassName(
    "pointer-events-none fixed right-4 top-[calc(var(--desktop-header-h)+8px)] z-[200] ",
  ) +
  utilityClassName(
    "phone:inset-x-0 phone:right-0 phone:px-3 phone:top-[calc(var(--header-h)+8px)]",
  );

export const TOAST_NOTICE_LANE = utilityClassName(
  "pointer-events-none inset-x-0 bottom-[124px] z-[200]",
);

/**
 * Live status is product-wide rather than composer-aligned. On phones it clears
 * the fixed header and an optional docked tab strip.
 */
export const ONGOING_TOAST_POSITION = utilityClassName(
  "fixed bottom-10 phone:top-[calc(var(--pane-header-h)+var(--strip-clearance,0px)+8px)] phone:bottom-auto",
);

export const PERSISTENT_NOTICE_SHELF =
  utilityClassName(
    "pointer-events-none fixed bottom-2 left-2 z-[9500] flex w-fit ",
  ) + utilityClassName("max-w-[calc(100vw-16px)] flex-col gap-2");

/** Card shared by durable update and desktop-link prompts. */
export const PERSISTENT_NOTICE_CARD =
  utilityClassName(
    "pointer-events-auto flex w-full items-center justify-between gap-2 ",
  ) +
  utilityClassName(
    "rounded-row border border-[color:var(--composer-border)] bg-[var(--composer-surface)] ",
  ) +
  utilityClassName(
    "smooth-shadow-md py-1.5 pr-1.5 pl-3 phone:shadow-[var(--composer-shadow)] ",
  ) +
  utilityClassName(
    "animate-[update-toast-in_var(--dur-lg)_var(--ease)] motion-reduce:animate-none",
  );
