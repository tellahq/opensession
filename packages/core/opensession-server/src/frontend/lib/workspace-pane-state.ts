import type { Dispatch, SetStateAction } from "react";

export interface ReviewFocus {
  repo: string;
  branch?: string;
  number?: number;
  workspaceId?: string;
  seq: number;
}

export function addReviewTab(
  setReviewOpen: Dispatch<SetStateAction<Set<string>>>,
  setReviewClosed: Dispatch<SetStateAction<Set<string>>>,
  key: string,
) {
  setReviewOpen((previous) =>
    previous.has(key) ? previous : new Set(previous).add(key),
  );
  setReviewClosed((previous) => {
    if (!previous.has(key)) return previous;
    const next = new Set(previous);
    next.delete(key);
    return next;
  });
}

export function requestReviewFocus(
  setReviewFocus: Dispatch<SetStateAction<ReviewFocus | null>>,
  focus: Omit<ReviewFocus, "seq">,
) {
  setReviewFocus((previous) => ({
    ...focus,
    seq: (previous?.seq ?? 0) + 1,
  }));
}
