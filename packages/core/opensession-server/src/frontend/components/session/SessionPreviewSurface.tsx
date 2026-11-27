import type { ComponentProps } from "react";
import { VIEWER_REVIEW_MAIN } from "../../lib/session-viewer-classes";
import { IconArrowUpRight, IconCopy, IconGlobe } from "../icons";
import { Button } from "../../ui/button";
import { BrowserPane } from "../BrowserPane";
import { keptFrameKey } from "../../lib/kept-frames";
import { LINK_FRAME, PREVIEW_FRAME } from "../../lib/preview-url";
import { PortalPane } from "../PortalPane";

interface StagingDeployment {
  status: string;
  embeddable?: boolean;
}

interface SessionStagingPaneProps {
  deployment: StagingDeployment | null;
  url: string;
  shareLink: (
    link: string,
    options?: { toast?: string | boolean; title?: string },
  ) => void;
}

type PreviewSurface =
  | {
      kind: "portal";
      target: ComponentProps<typeof PortalPane>["target"];
    }
  | { kind: "browser"; url: string }
  | {
      kind: "staging";
      deployment: StagingDeployment | null;
      url: string;
      shareLink: SessionStagingPaneProps["shareLink"];
    };

/** The active workspace preview tab. */
export function SessionPreviewSurface({
  surface,
  frameScope,
  inPanel = false,
  commentSessionId,
}: {
  surface: PreviewSurface;
  /** Keeps the page loaded across tab and session switches; see BrowserPane. */
  frameScope?: string;
  /** The side panel's Browser tab, whose page is kept apart from the main
   *  strip's: the two can hold different pages. */
  inPanel?: boolean;
  /** Where a comment on the page goes; see BrowserAnnotationLayer. */
  commentSessionId?: string;
}) {
  const browserKey =
    frameScope && keptFrameKey(inPanel ? "panel" : "staging", frameScope);
  switch (surface.kind) {
    case "portal":
      return (
        <div className={VIEWER_REVIEW_MAIN}>
          <PortalPane
            target={surface.target}
            keepAliveKey={frameScope && keptFrameKey("portal", frameScope)}
            commentSessionId={commentSessionId}
          />
        </div>
      );
    case "browser":
      // A link opened from the transcript. It shares the Browser tab, and so
      // its kept-alive frame, with the preview deployment.
      return (
        <div className={VIEWER_REVIEW_MAIN}>
          <BrowserPane
            url={surface.url}
            name={LINK_FRAME.name}
            frameTitle={LINK_FRAME.title}
            keepAliveKey={browserKey}
            commentSessionId={commentSessionId}
            allow={LINK_FRAME.allow}
            sandbox={LINK_FRAME.sandbox}
          />
        </div>
      );
    case "staging":
      return (
        <SessionStagingPane
          deployment={surface.deployment}
          url={surface.url}
          shareLink={surface.shareLink}
          keepAliveKey={browserKey}
          commentSessionId={commentSessionId}
        />
      );
  }
}

/** The embedded or first-party fallback view for a PR preview deployment. */
function SessionStagingPane({
  deployment,
  url,
  shareLink,
  keepAliveKey,
  commentSessionId,
}: SessionStagingPaneProps & {
  keepAliveKey?: string;
  commentSessionId?: string;
}) {
  if (deployment?.embeddable) {
    // This deploy opts into being framed by this app (its CSP frame-ancestors
    // names our origin), so we embed it inline. When the deploy's session
    // cookie is scoped to a parent domain this app also sits under
    // (SameSite=None; Secure), it rides into the frame on every device, iOS
    // included, so a logged-in reviewer sees the deploy directly. A logged-OUT
    // one gets a blank frame (staging redirects to WorkOS AuthKit, which refuses
    // framing), so the header keeps a first-party "Open" break-out to log in,
    // then come back.
    return (
      <div className={VIEWER_REVIEW_MAIN}>
        <BrowserPane
          url={url}
          name={PREVIEW_FRAME.name}
          keepAliveKey={keepAliveKey}
          commentSessionId={commentSessionId}
          frameTitle={PREVIEW_FRAME.title}
          allow={PREVIEW_FRAME.allow}
          leading={
            deployment.status !== "Ready" ? (
              <span className="mr-1 shrink-0 text-xs text-dim">
                {deployment.status}…
              </span>
            ) : undefined
          }
          actions={
            <Button
              variant="ghost"
              size="md"
              className="rounded-control"
              icon={<IconCopy size={20} />}
              onClick={() => shareLink(url, { toast: "Link copied" })}
              aria-label="Copy preview link"
              title="Copy link"
            />
          }
        />
      </div>
    );
  }

  // Deploy hasn't opted into being framed (older preview, or the fusion CSP
  // change hasn't reached it yet), so open it first-party in a new tab rather
  // than show a blocked frame.
  return (
    <div className={VIEWER_REVIEW_MAIN}>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <IconGlobe size={40} className="text-dim" />
        <div className="flex flex-col items-center gap-1">
          <div className="text-base font-medium text-fg">
            Preview environment
          </div>
          <div className="text-xs text-dim">
            {deployment?.status === "Ready"
              ? "Test this PR on real infra"
              : `Deploy is ${(deployment?.status ?? "building").toLowerCase()}…`}
          </div>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-panel"
        >
          <IconGlobe size={20} />
          Open staging
          <IconArrowUpRight size={20} />
        </a>
        <button
          type="button"
          onClick={() => shareLink(url, { toast: "Link copied" })}
          className="inline-flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-fg"
        >
          <IconCopy size={20} />
          Copy link
        </button>
        <div className="max-w-xs text-xs leading-relaxed text-dim">
          Opens in a new tab. This deploy isn&apos;t set up to embed here yet.
        </div>
      </div>
    </div>
  );
}
