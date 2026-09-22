import type { ReactNode } from "react";
import type { Provider } from "../../lib/provider";
import { WS_SUMMARY_REVIEW_CANVAS_CLEARANCE } from "../../lib/workspace-summary-classes";
import type {
  PrComment,
  PrDetails,
  SessionWalkthrough,
  WSClientMessage,
} from "../../lib/types";
import { SelectionToSession } from "../SelectionToSession";
import { WalkthroughCard } from "../WalkthroughCard";
import { PrStateIcon } from "./PrStateIcon";
import { ConversationView } from "./PrViews";

interface Props {
  compactToolbar: boolean;
  sessionId: string;
  provider: Provider;
  pr: PrDetails;
  send?: (message: WSClientMessage) => void;
  railStacked: boolean;
  rail: ReactNode;
  hideWideOverviewRail: boolean;
  walkthrough?: SessionWalkthrough;
  bodyHtml: string;
  comments: PrComment[];
  markdownRepo?: string;
  onAddToInput?: (text: string) => void;
}

/** The conversation and metadata page of a pull request review. */
export function PrOverviewPage({
  compactToolbar,
  sessionId,
  provider,
  pr,
  send,
  railStacked,
  rail,
  hideWideOverviewRail,
  walkthrough,
  bodyHtml,
  comments,
  markdownRepo,
  onAddToInput,
}: Props) {
  return (
    <div
      className={`flex min-h-0 flex-1 ${compactToolbar ? `${WS_SUMMARY_REVIEW_CANVAS_CLEARANCE} desktop:flex-none desktop:[--review-file-tree-gap:0px] desktop:[--review-file-tree-top:60px]` : ""}`}
    >
      <main
        className={`min-w-0 flex-1 bg-surface ${compactToolbar ? "overflow-y-visible" : "overflow-y-auto"} pb-4`}
      >
        <SelectionToSession
          sessionId={sessionId}
          label={`${provider.changeAbbr} #${pr.number}`}
          send={send}
        >
          <div
            className={`mx-auto w-full max-w-[1120px] px-6 py-6 phone:px-3 ${railStacked ? "flex flex-col gap-6" : "flex gap-8"}`}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-5">
              <header className="hidden space-y-2 phone:block">
                <h1 className="m-0 break-words text-lg font-semibold leading-snug text-fg">
                  {pr.title}
                </h1>
                <div className="flex items-center gap-2 text-xs text-dim">
                  <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
                  <span>
                    {pr.isDraft
                      ? "Draft"
                      : pr.state === "OPEN"
                        ? "Open"
                        : pr.state === "MERGED"
                          ? "Merged"
                          : "Closed"}
                  </span>
                  <span>#{pr.number}</span>
                </div>
              </header>
              {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}
              <ConversationView
                author={pr.author}
                descriptionHtml={bodyHtml}
                comments={comments}
                provider={provider}
                repo={markdownRepo}
                onAddToInput={onAddToInput}
                pr={pr}
              />
            </div>
            {railStacked && <div className="desktop:order-first">{rail}</div>}
            {!railStacked && !hideWideOverviewRail && rail}
          </div>
        </SelectionToSession>
      </main>
    </div>
  );
}
