export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** GitHub forbids both approval and change requests on your own PR. */
export function canGiveReviewVerdict(
  provider: string,
  author: string | undefined,
  viewerLogin: string | null | undefined,
): boolean {
  if (provider !== "github") return true;
  // While identity is unresolved, comments remain safe but verdicts do not.
  return Boolean(
    author?.trim() &&
    viewerLogin?.trim() &&
    author.trim().toLowerCase() !== viewerLogin.trim().toLowerCase(),
  );
}

export function allowedReviewEvent(
  event: ReviewEvent,
  canGiveVerdict: boolean,
): ReviewEvent {
  return canGiveVerdict ? event : "COMMENT";
}

export const REVIEW_VERDICTS: ReadonlyArray<{
  event: ReviewEvent;
  label: string;
  hint: string;
}> = [
  { event: "APPROVE", label: "Approve", hint: "Sign off on these changes" },
  {
    event: "COMMENT",
    label: "Comment",
    hint: "Leave feedback without a verdict",
  },
  {
    event: "REQUEST_CHANGES",
    label: "Request changes",
    hint: "Ask for another pass before merging",
  },
];
