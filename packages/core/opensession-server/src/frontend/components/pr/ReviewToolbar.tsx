import type { ReactNode } from "react";
import { WS_SUMMARY_REVIEW_BAR_CLEARANCE } from "../../lib/workspace-summary-classes";

/**
 * The floating review toolbar shared by branches with and without a pull
 * request. It stays edge to edge on phone and clears the standing workspace
 * summary on wide review canvases. Only the rounded inner bar paints, so review
 * content remains visible as it passes beneath the transparent sticky inset.
 */
export function ReviewToolbar({
  children,
  compact,
}: {
  children: ReactNode;
  compact: boolean;
}) {
  const placement = compact
    ? `sticky top-0 z-20 desktop:mb-0 desktop:ml-2 desktop:pb-2 ${WS_SUMMARY_REVIEW_BAR_CLEARANCE}`
    : "desktop:mx-2 desktop:mb-2";

  return (
    <>
      <div className={`relative shrink-0 desktop:pt-2.5 ${placement}`}>
        <div
          className={`relative bg-surface desktop:rounded-lg desktop:smooth-shadow-ring-sm ${compact ? "desktop:overflow-hidden" : "desktop:overflow-visible"}`}
        >
          {children}
        </div>
      </div>
    </>
  );
}
