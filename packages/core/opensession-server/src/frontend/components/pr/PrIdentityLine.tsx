import type { PrStatusMark } from "../../lib/pr-status";
import type { Provider } from "../../lib/provider";
import type { PrDetails } from "../../lib/types";
import { DiffStat } from "../DiffStat";
import { UserAvatar } from "../UserAvatar";
import { CopyTextButton } from "./CopyTextButton";
import { PrStateIcon } from "./PrStateIcon";

const STATE_LABEL = {
  OPEN: "Open",
  MERGED: "Merged",
  CLOSED: "Closed",
} as const;

/**
 * The facts GitHub puts under a pull request's title, on one wrapping line:
 * state, who wants to merge it, which branch lands where, and its size.
 */
export function PrIdentityLine({
  pr,
  provider,
  statusMark,
  showSize = true,
}: {
  pr: PrDetails;
  provider: Provider;
  statusMark: PrStatusMark;
  /** Leave the size out where the tab row already carries it. */
  showSize?: boolean;
}) {
  const fileCount = pr.changedFiles || pr.files?.length || 0;
  return (
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
      {showSize && (
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
      )}
    </div>
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
