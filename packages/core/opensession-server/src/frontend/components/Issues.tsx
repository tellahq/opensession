import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UnifiedSession } from "../lib/types";
import {
  fetchOpenIssues,
  relativeTime,
  startIssueSession,
  type OpenIssue,
} from "../lib/api";
import { compactAge, dateGroup, personLabel } from "../lib/pr-rows";
import { renderPrCommentMarkdown } from "../lib/markdown";
import {
  PR_GROUP_LABEL,
  PR_LIST,
  PR_PAGE_COLUMN,
  PR_ROW,
  PR_SECTION_LABEL,
} from "../lib/pr-list-classes";
import { Button } from "../ui/button";
import { useIsPhone } from "../hooks/useIsPhone";
import { ResponsiveDialog } from "../ui/sheet";
import { toast } from "../ui/toast";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { Input } from "../ui/input";
import { EmptyState, LoadingState } from "../ui/state";
import { cn } from "../ui/cn";
import { MarkdownBody } from "./MarkdownBody";
import { useCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { RepoTile, repoLabel } from "./RepoTile";
import { IconIssue, IconRepo, IconSearch, IconX } from "./icons";

interface Props {
  sessions: UnifiedSession[];
  onOpenSession: (id: string) => void;
  /** The pane's top bar, where this page's controls go. */
  topbarActionsEl?: HTMLElement | null;
}

const POLL_MS = 60_000;

/** What the row says about the issue's session, if anything. */
function sessionState(
  issue: OpenIssue,
  session: UnifiedSession | undefined,
  starting: boolean,
): { label: string; tone: string } | null {
  if (session?.isRunning) return { label: "Running", tone: "text-accent" };
  if (session) return { label: "Session", tone: "text-dim" };
  if (starting || issue.assigned)
    return { label: "Starting", tone: "text-dim" };
  return null;
}

export function Issues({ sessions, onOpenSession, topbarActionsEl }: Props) {
  const currentUser = useCurrentUser();
  const isPhone = useIsPhone();
  const [issues, setIssues] = useState<OpenIssue[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchExpanded = searchActive || query.length > 0;
  const [repo, setRepo] = useState("all");
  const [preview, setPreview] = useState<OpenIssue | null>(null);
  // Sessions asked for from this page whose row has not caught up yet.
  const [started, setStarted] = useState<Set<string>>(() => new Set());
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (searchActive) searchInputRef.current?.focus();
  }, [searchActive]);

  const load = React.useCallback(() => {
    return fetchOpenIssues()
      .then((rows) => {
        setIssues(rows);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const sessionById = useMemo(
    () => new Map(sessions.map((s) => [s.id, s])),
    [sessions],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (issues || []).filter((issue) => {
      if (repo !== "all" && issue.repo !== repo) return false;
      if (!needle) return true;
      return [
        issue.title,
        `#${issue.number}`,
        issue.author,
        issue.repo,
        ...issue.labels,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [issues, query, repo]);

  const groups = useMemo(() => {
    const byDay = new Map<string, OpenIssue[]>();
    for (const issue of filtered) {
      const label = dateGroup(issue.updatedAt);
      byDay.set(label, [...(byDay.get(label) || []), issue]);
    }
    return [...byDay.entries()];
  }, [filtered]);

  const repoOptions = [
    ...new Set((issues || []).map((issue) => issue.repo)),
  ].sort();

  async function start(issue: OpenIssue) {
    if (starting) return;
    setStarting(true);
    // No `finally`: the React Compiler does not lower one yet.
    const outcome = await startIssueSession({
      repo: issue.repo,
      number: issue.number,
      user: currentUser,
    }).then(
      () => null,
      // ApiError from the request helper, or a network failure.
      (e: Error) => e.message || "Couldn't start the session",
    );
    setStarting(false);
    if (outcome) {
      toast(outcome);
      return;
    }
    setStarted((prev) => new Set(prev).add(issue.sessionId));
    toast("Session started");
    // The label lands on GitHub a moment later; pick it up.
    setTimeout(() => void load(), 3000);
  }

  // Search beside the page name, the repo scope trailing: the same row the
  // pull request list puts in the top bar.
  const actions = (
    <>
      <div
        className={cn(
          "relative h-8 shrink-0 transition-[width] duration-standard ease-standard motion-reduce:transition-none",
          searchExpanded ? "w-[200px] min-w-[90px] shrink-[100]" : "w-8",
        )}
      >
        <Input
          ref={searchInputRef}
          className={cn(
            "absolute inset-0 h-8 pl-8 [&::-webkit-search-cancel-button]:hidden",
            "transition-opacity duration-micro ease-standard motion-reduce:transition-none",
            searchExpanded ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          type="search"
          aria-label="Search issues"
          placeholder="Search issues…"
          value={query}
          tabIndex={searchExpanded ? 0 : -1}
          onFocus={() => setSearchActive(true)}
          onBlur={() => setSearchActive(false)}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setQuery("");
            setSearchActive(false);
            event.currentTarget.blur();
          }}
          spellCheck={false}
        />
        <Tooltip label="Search" side="bottom">
          <Button
            variant="ghost"
            icon={<IconSearch size={20} />}
            className={cn(
              "absolute inset-y-0 left-0 z-sticky",
              searchExpanded && "pointer-events-none text-faint",
            )}
            aria-label="Search issues"
            aria-expanded={searchExpanded}
            aria-hidden={searchExpanded || undefined}
            tabIndex={searchExpanded ? -1 : 0}
            onClick={() => setSearchActive(true)}
          />
        </Tooltip>
      </div>

      {repoOptions.length > 1 && (
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  variant="ghost"
                  className="min-w-0"
                  icon={<IconRepo size={20} />}
                  caret
                >
                  <span className="max-w-[150px] truncate">
                    {repo === "all" ? "All repos" : repoLabel(repo)}
                  </span>
                </Button>
              }
            />
            <Menu.Popup align="end" className="min-w-[200px] max-w-[320px]">
              <Menu.RadioGroup
                value={repo}
                onValueChange={(value) => setRepo(String(value))}
              >
                <Menu.RadioItem value="all" closeOnClick>
                  <span className="size-[18px] shrink-0" />
                  <span className="min-w-0 flex-1 truncate">All repos</span>
                  <Menu.Check on={repo === "all"} />
                </Menu.RadioItem>
                {repoOptions.map((name) => (
                  <Menu.RadioItem key={name} value={name} closeOnClick>
                    <RepoTile name={name} size={18} />
                    <span className="min-w-0 flex-1 truncate">
                      {repoLabel(name)}
                    </span>
                    <Menu.Check on={repo === name} />
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Root>
        </div>
      )}
    </>
  );

  const previewSession = preview
    ? sessionById.get(preview.sessionId)
    : undefined;
  const previewStarting = preview ? started.has(preview.sessionId) : false;

  return (
    <div
      data-page-scroll
      className="min-h-0 w-full flex-1 overflow-y-auto bg-surface"
    >
      {topbarActionsEl && !isPhone
        ? createPortal(actions, topbarActionsEl)
        : null}
      <div
        className={cn(
          PR_PAGE_COLUMN,
          "pb-15 pt-7 max-[560px]:px-4 max-[560px]:pb-12 max-[560px]:pt-[18px]",
        )}
      >
        {/* The phone's bar has no actions slot, and a pane without a bar has
            none either: the controls sit above the list instead. */}
        {(!topbarActionsEl || isPhone) && (
          <div className="mb-4 flex min-h-11 items-center gap-2">{actions}</div>
        )}
        {issues === null ? (
          error ? (
            <EmptyState
              title="Couldn't load issues"
              action={
                <Button size="sm" onClick={() => void load()}>
                  Try again
                </Button>
              }
            >
              Check the GitHub App connection for this workspace.
            </EmptyState>
          ) : (
            <LoadingState>Loading issues…</LoadingState>
          )
        ) : groups.length === 0 ? (
          <EmptyState title={query ? "No matching issues" : "No open issues"}>
            {query
              ? "Try another search or filter."
              : "Open issues from the registered repos appear here."}
          </EmptyState>
        ) : (
          <div className={PR_LIST}>
            <section className="mb-8">
              <h2 className={PR_SECTION_LABEL}>
                Open
                <span className="text-label font-medium text-faint">
                  {filtered.length}
                </span>
              </h2>
              {groups.map(([label, rows]) => (
                <div key={label} className="mb-5">
                  <h3 className={PR_GROUP_LABEL}>
                    {label}
                    <span className="font-medium">{rows.length}</span>
                  </h3>
                  <div>
                    {rows.map((issue) => {
                      const state = sessionState(
                        issue,
                        sessionById.get(issue.sessionId),
                        started.has(issue.sessionId),
                      );
                      return (
                        <button
                          key={`${issue.repo}#${issue.number}`}
                          className={PR_ROW}
                          onClick={() => setPreview(issue)}
                          title={`${repoLabel(issue.repo)} · #${issue.number}`}
                        >
                          <span className="flex items-center text-green">
                            <IconIssue size={20} />
                          </span>
                          {issue.person ? (
                            <UserAvatar
                              name={personLabel(issue.person)}
                              size={20}
                              title={personLabel(issue.person)}
                            />
                          ) : (
                            <RepoTile name={issue.repo} size={20} />
                          )}
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate text-item-title font-medium leading-tight text-fg">
                              {issue.title}
                            </span>
                            <span className="shrink-0 text-meta tabular-nums text-faint">
                              #{issue.number}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "justify-self-end text-meta phone:hidden",
                              state ? state.tone : "text-faint",
                            )}
                          >
                            {state
                              ? state.label
                              : issue.comments > 0
                                ? `${issue.comments} ${issue.comments === 1 ? "comment" : "comments"}`
                                : ""}
                          </span>
                          <span className="justify-self-end text-meta tabular-nums text-faint">
                            {compactAge(issue.updatedAt)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>
          </div>
        )}
      </div>

      <ResponsiveDialog
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        phone={isPhone}
        label={preview ? `Issue: ${preview.title}` : "Issue"}
        showPhoneGrabber={false}
        modalClassName="h-[min(760px,85vh)] w-[min(880px,92vw)] max-w-none bg-surface"
        sheetClassName="top-0 h-[100dvh] max-h-none bg-surface [border-radius:0]! [box-shadow:none]!"
      >
        {preview && (
          <>
            <div className="flex min-h-13 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 phone:min-h-14">
              <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-item-title font-medium text-fg">
                <IconIssue size={20} className="shrink-0 text-dim" />
                <span className="truncate">{repoLabel(preview.repo)}</span>
                <span className="shrink-0 font-normal tabular-nums text-faint">
                  #{preview.number}
                </span>
              </div>
              <Button
                size="lg"
                variant="ghost"
                className="shrink-0"
                render={
                  <a href={preview.url} target="_blank" rel="noreferrer" />
                }
              >
                GitHub
              </Button>
              {previewSession ? (
                <Button
                  size="lg"
                  variant="primary"
                  className="shrink-0"
                  onClick={() => {
                    onOpenSession(previewSession.id);
                    setPreview(null);
                  }}
                >
                  Open session
                </Button>
              ) : (
                <Button
                  size="lg"
                  variant="primary"
                  className="shrink-0"
                  disabled={starting || previewStarting || preview.assigned}
                  onClick={() => void start(preview)}
                >
                  {previewStarting || preview.assigned
                    ? "Starting"
                    : "Start session"}
                </Button>
              )}
              <Button
                size="lg"
                variant="ghost"
                className="shrink-0"
                icon={<IconX size={20} />}
                aria-label="Close issue"
                onClick={() => setPreview(null)}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 phone:px-4">
              <h2 className="m-0 text-section-title font-title tracking-tight text-fg">
                {preview.title}
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-meta text-dim">
                <span className="inline-flex items-center gap-1.5">
                  {preview.person && (
                    <UserAvatar name={personLabel(preview.person)} size={16} />
                  )}
                  {preview.author}
                </span>
                <span
                  className="text-faint"
                  title={new Date(preview.createdAt).toLocaleString()}
                >
                  opened {relativeTime(preview.createdAt)}
                </span>
                {preview.labels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full bg-active px-2 py-px text-meta text-dim"
                  >
                    {label}
                  </span>
                ))}
              </div>
              {preview.body ? (
                <MarkdownBody
                  className="markdown mt-5"
                  html={renderPrCommentMarkdown(preview.body)}
                />
              ) : (
                <div className="mt-5 text-supporting text-faint">
                  No description.
                </div>
              )}
            </div>
          </>
        )}
      </ResponsiveDialog>
    </div>
  );
}
