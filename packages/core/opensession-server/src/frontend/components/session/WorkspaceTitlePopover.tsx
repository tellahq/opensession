import { useState, type ReactNode } from "react";
import { useSessionGitResource } from "../../hooks/useApiResources";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useNavigation } from "../../hooks/useNavigation";
import { relativeTime } from "../../lib/api";
import { cachedRepos } from "../../lib/repo-cache";
import {
  HIDDEN_BESIDE_TABS,
  VIEWER_BRANCH,
  VIEWER_BRANCH_EDITABLE,
} from "../../lib/session-viewer-classes";
import { useSessionRecords } from "../../lib/session-records";
import { startedSessions } from "../../lib/session-threads";
import { openThreadTab } from "../../lib/thread-tabs";
import { fullTime } from "../../lib/time";
import type { SessionUsage, UnifiedSession } from "../../lib/types";
import { fmtTokens, fmtUsd, totalTokens } from "../../lib/usage-format";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { OverflowFadeText } from "../../ui/overflow-fade-text";
import { Popover } from "../../ui/popover";
import {
  IconArrowUpRight,
  IconBranches,
  IconClock,
  IconDollarCircle,
  IconGitMerge,
  IconRepo,
  IconTokens,
} from "../icons";
import { ThreadCardSummary } from "../threads/ThreadCards";

/**
 * The header title as a button: a click opens a card with the whole name and
 * the workspace's facts (repository, age, spend, branches), so a long title is
 * readable and the facts that used to need the side panel are one click away.
 * Rename moved into the card's pencil; double-click still renames directly.
 *
 * Desktop only: on a phone this row is hidden and the title pill opens the
 * session info page instead.
 */
export function WorkspaceTitlePopover({
  session,
  leading,
  repoControl,
  title,
  sessions,
  canRename,
  renameLabel,
  onRename,
  onRenameTo,
}: {
  session: UnifiedSession;
  /** The repo tile (or repo-less mark) drawn inside the title button. */
  leading?: ReactNode;
  /** The repo switch/attach menu, shown as the Repository value. */
  repoControl?: ReactNode;
  title: string;
  /** Whose cost, tokens and age the card totals: the workspace's sessions,
   *  or just this one for a worker or a workspace-less session. */
  sessions: UnifiedSession[];
  canRename: boolean;
  renameLabel: string;
  onRename: () => void;
  onRenameTo?: (title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // The card's title edits in place: hover shows it is a field, a click
  // turns it into one. Its own draft, so the header's inline rename input
  // does not open behind the card.
  const [draft, setDraft] = useState<string | null>(null);
  const editable = canRename && Boolean(onRenameTo);
  const commit = () => {
    if (draft !== null && draft.trim() && draft.trim() !== title)
      onRenameTo?.(draft);
    setDraft(null);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) commit();
        setOpen(next);
      }}
    >
      <Popover.Trigger
        className={cn(
          VIEWER_BRANCH,
          VIEWER_BRANCH_EDITABLE,
          "flex cursor-pointer items-center gap-2 text-left",
          "data-[popup-open]:bg-hover",
          // Beside the tab strip the glyph alone opens the card; with no
          // glyph there is nothing left to press.
          !leading && HIDDEN_BESIDE_TABS,
        )}
        aria-label={title}
        onDoubleClick={
          canRename
            ? () => {
                setOpen(false);
                onRename();
              }
            : undefined
        }
      >
        {leading}
        <OverflowFadeText className={HIDDEN_BESIDE_TABS}>
          {title}
        </OverflowFadeText>
      </Popover.Trigger>
      <Popover.Popup
        side="bottom"
        align="start"
        sideOffset={8}
        alignOffset={-6}
        elevation="lg"
        initialFocus
        aria-label="Workspace details"
        // Less at the bottom: the last row's 32px box already leaves ~7px
        // under its text, so pb-2.5 lands the gap level with the top's 16px.
        className="w-[min(340px,calc(100vw-24px))] p-4 pb-2.5"
      >
        {draft !== null ? (
          <textarea
            aria-label={renameLabel}
            className={cn(
              CARD_TITLE,
              "block w-full resize-none bg-surface outline outline-1 outline-accent",
            )}
            rows={1}
            value={draft}
            autoFocus
            onFocus={(event) => event.target.select()}
            onChange={(event) =>
              setDraft(event.target.value.replace(/\n/g, " "))
            }
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(null);
              }
            }}
          />
        ) : editable ? (
          <h2 className="m-0">
            <button
              type="button"
              title={renameLabel}
              aria-label={`${title}. ${renameLabel}`}
              className={cn(
                CARD_TITLE,
                "block w-full cursor-text text-left transition-colors duration-micro ease-standard hover:bg-hover",
              )}
              onClick={() => setDraft(title)}
            >
              {title}
            </button>
          </h2>
        ) : (
          <h2 className={cn(CARD_TITLE, "m-0")}>{title}</h2>
        )}
        <WorkspaceFacts
          session={session}
          sessions={sessions}
          repoControl={repoControl}
          active={open}
          className="mt-3"
          onOpenSession={() => setOpen(false)}
        />
      </Popover.Popup>
    </Popover.Root>
  );
}

/**
 * The workspace's facts (repository, age, spend, branches), shared by the
 * title card and, in the new layout, the open tab's ⋯ menu.
 */
export function WorkspaceFacts({
  session,
  sessions,
  repoControl,
  active,
  className,
  onOpenSession,
}: {
  session: UnifiedSession;
  /** Whose cost, tokens and age to total. */
  sessions: UnifiedSession[];
  /** The repo switch/attach menu, shown as the Repository value. */
  repoControl?: ReactNode;
  /** Whether the surface is open: the target branch is fetched only then. */
  active: boolean;
  className?: string;
  /** Close the surface when one of the started sessions opens. */
  onOpenSession?: () => void;
}) {
  const navigation = useNavigation();
  const phone = useIsPhone();
  const started = startedSessions(useSessionRecords(), session.id);
  const repoId = !session.repoLess && !session.desk ? session.repo : undefined;
  const repo = repoId
    ? cachedRepos().find((info) => info.id === repoId)
    : undefined;
  // Fetched on open only: the header renders on every session switch, and the
  // target branch is the one fact here that needs a request. SWR shares the
  // answer with the side panel's git status.
  const git = useSessionGitResource(session.id, repoId, {
    enabled: active && Boolean(repoId && session.worktreeDir),
  }).data;

  // The open session is hydrated and fresher than its list row.
  const rows = sessions.some((s) => s.id === session.id)
    ? sessions.map((s) => (s.id === session.id ? session : s))
    : [session, ...sessions];
  const usages = rows
    .map((s) => s.usage)
    .filter((usage): usage is SessionUsage => Boolean(usage));
  const cost = usages.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);
  const tokens = usages.reduce((sum, usage) => sum + totalTokens(usage), 0);
  const created = rows
    .map((s) => s.createdAt)
    .filter(Boolean)
    .sort()[0];
  const branch = session.branch;
  const target = git?.baseBranch || repo?.defaultBranch;
  const scope =
    rows.length > 1 ? `Across ${rows.length} sessions` : "This session";

  return (
    <div className={className}>
      <dl className="m-0 flex flex-col">
        {repoId && (
          <Fact icon={<IconRepo size={20} />} label="Repository">
            <span className="flex min-w-0 items-center gap-1">
              {repoControl ?? (
                <span className="truncate">{repo?.label || repoId}</span>
              )}
              {repo?.ghRepo && (
                <a
                  href={`https://github.com/${repo.ghRepo}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${repo.ghRepo} on GitHub`}
                  title={`Open ${repo.ghRepo} on GitHub`}
                  className="-mr-1 inline-flex size-6 flex-none items-center justify-center rounded-sm text-dim transition-colors hover:bg-hover hover:text-fg"
                >
                  <IconArrowUpRight size={20} />
                </a>
              )}
            </span>
          </Fact>
        )}
        {created && (
          <Fact icon={<IconClock size={20} />} label="Created">
            <span title={fullTime(created)}>{relativeTime(created)}</span>
          </Fact>
        )}
        {usages.length > 0 && (
          <>
            <Fact icon={<IconDollarCircle size={20} />} label="Agent cost">
              <span title={scope}>{fmtUsd(cost)}</span>
            </Fact>
            <Fact icon={<IconTokens size={20} />} label="Tokens">
              <span title={scope}>{fmtTokens(tokens)}</span>
            </Fact>
          </>
        )}
      </dl>
      {branch && (
        <>
          <div className="my-3 h-px bg-line" />
          <dl className="m-0 flex flex-col">
            <Fact icon={<IconBranches size={20} />} label="Branch">
              <span className="truncate text-dim" title={branch}>
                {branch}
              </span>
            </Fact>
            {target && (
              <Fact icon={<IconGitMerge size={20} />} label="Target branch">
                <span className="truncate text-dim" title={target}>
                  {target}
                </span>
              </Fact>
            )}
          </dl>
        </>
      )}
      {started.length > 0 && (
        <>
          <div className="my-3 h-px bg-line" />
          <div className="mb-1 text-meta text-faint">Started here</div>
          <div className="-mx-2 flex flex-col">
            {started.slice(0, STARTED_SHOWN).map((thread) => (
              <ListRow
                key={thread.id}
                className="items-center gap-3 rounded-lg px-2 py-1.5 font-sans hover:bg-hover"
                aria-label={`Open ${thread.title}`}
                onClick={() => {
                  onOpenSession?.();
                  // A tab of its own beside this one on desktop.
                  if (!phone) openThreadTab(thread.id);
                  navigation.openSession(thread.id);
                }}
              >
                <ThreadCardSummary thread={thread} />
              </ListRow>
            ))}
          </div>
          {started.length > STARTED_SHOWN && (
            <div className="mt-1 text-meta text-faint">
              {started.length - STARTED_SHOWN} more in Threads
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Started sessions the card lists before it counts the rest. */
const STARTED_SHOWN = 5;

/** The card's title, read or edited: the same box either way, so the text
 *  does not move when the field opens. Pulled out by its own padding so the
 *  words stay aligned with the rows under them. */
const CARD_TITLE =
  "-mx-1.5 -my-1 rounded-md border-0 px-1.5 py-1 font-[inherit] text-body font-medium text-fg [overflow-wrap:anywhere] [field-sizing:content]";

function Fact({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-4 text-label">
      <dt className="flex flex-none items-center gap-2.5 text-dim">
        <span className="flex text-faint">{icon}</span>
        {label}
      </dt>
      <dd className="m-0 ml-auto flex min-w-0 justify-end tabular-nums text-fg">
        {children}
      </dd>
    </div>
  );
}
