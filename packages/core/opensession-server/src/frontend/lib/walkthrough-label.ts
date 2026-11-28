export type WalkthroughMediaLabel = "before" | "after" | "demo";

export const WALKTHROUGH_LABEL_TEXT: Record<WalkthroughMediaLabel, string> = {
  before: "Before",
  after: "After",
  demo: "Demo",
};

export const WALKTHROUGH_LABEL_CLASS =
  "rounded-capsule bg-panel px-2 py-0.5 text-meta font-semibold leading-4 shadow-[inset_0_0_0_1px_var(--border),0_1px_1px_oklch(0_0_0_/_0.14)]";

export const WALKTHROUGH_LABEL_TONE: Record<WalkthroughMediaLabel, string> = {
  before:
    "text-red [background-image:linear-gradient(var(--red-soft),var(--red-soft))]",
  after:
    "text-green [background-image:linear-gradient(var(--green-soft),var(--green-soft))]",
  demo: "text-blue [background-image:linear-gradient(var(--blue-soft),var(--blue-soft))]",
};
