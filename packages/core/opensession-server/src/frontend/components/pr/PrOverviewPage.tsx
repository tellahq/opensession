import type { ReactNode } from "react";
import type { PrStatusMark } from "../../lib/pr-status";
import type { Provider } from "../../lib/provider";
import { WS_SUMMARY_REVIEW_CANVAS_CLEARANCE } from "../../lib/workspace-summary-classes";
import type {
  PrComment,
  PrDetails,
  SessionWalkthrough,
  WSClientMessage,
} from "../../lib/types";
import { DiffStat } from "../DiffStat";
import { IconArrowRight } from "../icons";
import { CopyTextButton } from "./CopyTextButton";
import { SelectionToSession } from "../SelectionToSession";
import { UserAvatar } from "../UserAvatar";
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
  /** The merge box, leading the conversation while the rail sits beside it. */
  mergeBox?: ReactNode;
  statusMark: PrStatusMark;
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
  mergeBox,
  statusMark,
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
              {/* Phone only: the bar above names the PR by number, so the
                  page opens on everything a reviewer checks first. */}
              <PhoneIdentity
                pr={pr}
                provider={provider}
                statusMark={statusMark}
              />
              {/* Desktop: the title as the page's heading, and the facts
                  GitHub puts under it: state, author, branches, size. */}
              <DesktopIdentity
                pr={pr}
                provider={provider}
                statusMark={statusMark}
              />
              {/* Stacked, the status rail leads: whether it is green,
                  approved and mergeable answers more than the description.
                  Beside it, the merge box does that job. */}
              {railStacked ? rail : mergeBox}
              {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}
              <ConversationView
                descriptionHtml={bodyHtml}
                comments={comments}
                provider={provider}
                repo={markdownRepo}
                onAddToInput={onAddToInput}
                pr={pr}
              />
            </div>
            {!railStacked && !hideWideOverviewRail && rail}
          </div>
        </SelectionToSession>
      </main>
    </div>
  );
}

const STATE_LABEL = {
  OPEN: "Open",
  MERGED: "Merged",
  CLOSED: "Closed",
} as const;

/**
 * The phone overview's opening block: state and size, the full title, who
 * opened it, and which branch lands where. The desktop identity bar carries
 * the same facts on one line.
 */
function PhoneIdentity({
  pr,
  provider,
  statusMark,
}: {
  pr: PrDetails;
  provider: Provider;
  statusMark: PrStatusMark;
}) {
  const fileCount = pr.changedFiles || pr.files?.length || 0;
  return (
    <header className="hidden space-y-2.5 phone:block">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-supporting">
        <span
          className={`flex h-6 items-center gap-1.5 rounded-control px-2 font-medium ${statusMark.bgClassName} ${statusMark.className}`}
          title={statusMark.label}
        >
          <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
          {pr.isDraft && pr.state === "OPEN" ? "Draft" : STATE_LABEL[pr.state]}
        </span>
        <DiffStat
          files={pr.files ?? []}
          additions={pr.additions}
          deletions={pr.deletions}
        />
        {fileCount > 0 && (
          <span className="text-dim tabular-nums">
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </span>
        )}
      </div>
      <h1 className="m-0 break-words text-lg font-semibold leading-snug text-fg">
        {pr.title}
      </h1>
      {pr.author && (
        <div className="flex min-w-0 items-center gap-2 text-supporting font-medium text-fg">
          <UserAvatar
            name={pr.author}
            login={provider.key === "github" ? pr.author : null}
            size={20}
            edge={false}
          />
          <span className="min-w-0 truncate">{pr.author}</span>
        </div>
      )}
      {/* Its own line, wrapping rather than truncating: a branch name's
          distinguishing part is usually its end. */}
      {pr.headRefName && pr.baseRefName && (
        <p className="m-0 break-all font-mono text-meta leading-relaxed text-dim">
          {pr.headRefName}
          <IconArrowRight
            size={12}
            className="mx-1 inline-block align-[-1px] text-faint"
          />
          <span className="sr-only"> into </span>
          {pr.baseRefName}
        </p>
      )}
    </header>
  );
}

/**
 * The desktop overview's heading block, in GitHub's shape: the title large,
 * then one wrapping line of state, author, branches and size. The toolbar
 * above keeps the same identity on one line for both pages.
 */
function DesktopIdentity({
  pr,
  provider,
  statusMark,
}: {
  pr: PrDetails;
  provider: Provider;
  statusMark: PrStatusMark;
}) {
  const fileCount = pr.changedFiles || pr.files?.length || 0;
  return (
    <header className="mx-auto w-full max-w-[760px] space-y-3 pb-1 phone:hidden">
      <h1 className="m-0 break-words text-page-title font-semibold leading-tight text-fg">
        {pr.title}{" "}
        <a
          className="font-normal text-faint no-underline hover:text-link"
          href={pr.url}
          target="_blank"
          rel="noopener"
        >
          #{pr.number}
        </a>
      </h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-supporting">
        <span
          className={`flex h-7 items-center gap-1.5 rounded-[999px] px-2.5 font-medium ${statusMark.bgClassName} ${statusMark.className}`}
          title={statusMark.label}
        >
          <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
          {pr.isDraft && pr.state === "OPEN" ? "Draft" : STATE_LABEL[pr.state]}
        </span>
        {pr.author && (
          <span className="flex min-w-0 items-center gap-1.5 text-dim">
            <UserAvatar
              name={pr.author}
              login={provider.key === "github" ? pr.author : null}
              size={20}
              edge={false}
            />
            <span className="font-medium text-fg">{pr.author}</span>
            {pr.state === "MERGED" ? "merged into" : "wants to merge into"}
          </span>
        )}
        {pr.headRefName && pr.baseRefName && (
          <span className="flex min-w-0 items-center gap-1.5">
            <BranchChip name={pr.baseRefName} />
            <span className="text-faint">from</span>
            <BranchChip name={pr.headRefName} copyable />
          </span>
        )}
        <span className="flex items-center gap-2">
          <DiffStat
            files={pr.files ?? []}
            additions={pr.additions}
            deletions={pr.deletions}
          />
          {fileCount > 0 && (
            <span className="text-dim tabular-nums">
              {fileCount} {fileCount === 1 ? "file" : "files"}
            </span>
          )}
        </span>
      </div>
    </header>
  );
}

function BranchChip({ name, copyable }: { name: string; copyable?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5 rounded-md bg-control py-0.5 pl-2 pr-0.5 font-mono text-meta text-link">
      <span className={`min-w-0 truncate ${copyable ? "" : "pr-1.5"}`}>
        {name}
      </span>
      {copyable && <CopyTextButton text={name} label="Copy branch name" />}
    </span>
  );
}
