import { use } from "react";
import { NavigationContext } from "../hooks/useNavigation";
import { useSessionPrResource } from "../hooks/useApiResources";
import { useSessionPendingCreation } from "../hooks/useSessionPendingCreation";
import { PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import { previewOpenable, stagingHref } from "../lib/preview-url";
import type { PrDetails, SessionPrRef } from "../lib/types";
import { cn } from "../ui/cn";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { IconGlobe } from "./icons";

type PrStaging = NonNullable<PrDetails["staging"]>;

/** Pointer and press. The press step also takes a hair of scale, which is what
 *  makes a 28px target feel like it answered. */
export const SUMMARY_MARK_HOVER =
  "hover:bg-[color-mix(in_srgb,currentColor_26%,transparent)] " +
  "active:scale-[0.96] active:bg-[color-mix(in_srgb,currentColor_34%,transparent)]";

/** The preview deploy of one of a workspace's other PRs, read through the
 *  session's PR API for that PR's branch. Null when it has none. */
export function usePrRefStaging(
  sessionId: string | undefined,
  prRef: SessionPrRef,
  refreshTick?: number,
): PrStaging | null {
  const pendingCreation = useSessionPendingCreation();
  const open = !!sessionId && prRef.state === "OPEN";
  const prResource = useSessionPrResource(
    sessionId ?? "",
    prRef.repo,
    prRef.branch,
    {
      enabled: open && !pendingCreation,
      refreshInterval: PR_WEBHOOK_FALLBACK_POLL_MS,
      revision: refreshTick,
    },
  );
  return open ? (prResource.data?.staging ?? null) : null;
}

/**
 * The preview mark on one of a workspace's other PRs (a second PR the session
 * opened on another branch), in its summary card row where the PR glyph
 * would be. Same globe and colouring as the primary band's, but for that PR's
 * own deploy, so each PR's preview is one click away. A plain click opens it
 * in the Browser tab; modifier clicks keep the browser's own meaning.
 */
export function PrRefStagingMark({
  staging,
  number,
  className,
}: {
  staging: PrStaging;
  number?: number;
  className?: string;
}) {
  const navigation = use(NavigationContext);
  const openable = previewOpenable(staging);
  const href = stagingHref(staging);
  const subject = number != null ? ` for #${number}` : "";
  return (
    <Tooltip
      label={
        openable
          ? `Open the preview environment${subject}`
          : `Preview environment ${staging.status.toLowerCase()}…`
      }
      side="bottom"
    >
      <a
        href={href}
        target="_blank"
        rel="noopener"
        aria-label={`Preview environment${subject}`}
        aria-disabled={!openable || undefined}
        className={cn(
          "grid size-7 place-items-center rounded-md no-underline focus-ring",
          openable ? "text-green" : "text-yellow",
          openable ? SUMMARY_MARK_HOVER : "cursor-default",
          className,
        )}
        onClick={(e) => {
          if (!openable) {
            e.preventDefault();
            toast(
              `Preview environment is ${staging.status.toLowerCase()}. The link goes live once the first deploy finishes.`,
            );
            return;
          }
          if (
            !navigation ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
          )
            return;
          e.preventDefault();
          navigation.openBrowser(href);
        }}
      >
        <IconGlobe size={20} />
      </a>
    </Tooltip>
  );
}
