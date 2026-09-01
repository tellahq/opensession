import type { ComponentProps } from "react";
import type { PreviewStatus } from "../../lib/api";
import { VIEWER_REVIEW_MAIN } from "../../lib/session-viewer-classes";
import type { UnifiedSession } from "../../lib/types";
import { IconArrowUpRight, IconCopy, IconGlobe } from "../icons";
import { PortalPane } from "../PortalPane";
import { PreviewPane } from "../PreviewPane";

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
  | {
      kind: "preview";
      session: UnifiedSession;
      status: PreviewStatus | null;
      onClose: () => void;
    }
  | {
      kind: "staging";
      deployment: StagingDeployment | null;
      url: string;
      shareLink: SessionStagingPaneProps["shareLink"];
    };

/** The active workspace preview tab. */
export function SessionPreviewSurface({
  surface,
}: {
  surface: PreviewSurface;
}) {
  switch (surface.kind) {
    case "portal":
      return (
        <div className={VIEWER_REVIEW_MAIN}>
          <PortalPane target={surface.target} />
        </div>
      );
    case "preview":
      return (
        <div className={VIEWER_REVIEW_MAIN}>
          <PreviewPane
            session={surface.session}
            status={surface.status}
            onClose={surface.onClose}
          />
        </div>
      );
    case "staging":
      return (
        <SessionStagingPane
          deployment={surface.deployment}
          url={surface.url}
          shareLink={surface.shareLink}
        />
      );
  }
}

/** The embedded or first-party fallback view for a PR preview deployment. */
function SessionStagingPane({
  deployment,
  url,
  shareLink,
}: SessionStagingPaneProps) {
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
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-divider bg-panel px-3 py-1.5 text-xs text-dim">
            <IconGlobe size={14} />
            <span className="truncate">
              Preview environment
              {deployment.status !== "Ready"
                ? ` · ${deployment.status.toLowerCase()}…`
                : ""}
            </span>
            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                onClick={() => shareLink(url, { toast: "Link copied" })}
                className="inline-flex items-center gap-1 transition-colors hover:text-fg"
              >
                <IconCopy size={13} />
                Copy link
              </button>
              <a
                href={url}
                target="_blank"
                rel="noopener"
                title="Open first-party in a new tab. Needed if the frame is blank because you aren't logged in to the preview environment yet."
                className="inline-flex items-center gap-1 transition-colors hover:text-fg"
              >
                Open
                <IconArrowUpRight size={13} />
              </a>
            </div>
          </div>
          <iframe
            key={url}
            src={url}
            title="Preview environment"
            className="min-h-0 flex-1 border-0 bg-surface"
            allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write"
          />
        </div>
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
          <IconGlobe size={16} />
          Open staging
          <IconArrowUpRight size={16} />
        </a>
        <button
          type="button"
          onClick={() => shareLink(url, { toast: "Link copied" })}
          className="inline-flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-fg"
        >
          <IconCopy size={14} />
          Copy link
        </button>
        <div className="max-w-xs text-xs leading-relaxed text-dim">
          Opens in a new tab. This deploy isn&apos;t set up to embed here yet.
        </div>
      </div>
    </div>
  );
}
