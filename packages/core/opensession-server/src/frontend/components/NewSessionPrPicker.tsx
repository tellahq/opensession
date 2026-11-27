import React, { useEffect, useRef, useState } from "react";
import { fetchOpenPrs, type OpenPr } from "../lib/api";
import { matchingPullRequests } from "../lib/new-session-prs";
import { NO_REPO } from "../lib/session-repo";
import { cn } from "../ui/cn";
import { Input } from "../ui/input";
import { Menu } from "../ui/menu";
import {
  IconChevronRight,
  IconNewBranch,
  IconPullRequest,
  IconSearch,
} from "./icons";
import { RepoTile, repoLabel } from "./RepoTile";

interface Props {
  repo: string;
  selected: OpenPr | null;
  onSelect: (pullRequest: OpenPr) => void;
  onClear: () => void;
}

/**
 * The new-session composer's PR source picker, a submenu of the footer's
 * overflow menu. The parent owns the selected start point; this component only
 * owns the cached open-PR list and its search.
 */
export function NewSessionPrPicker({
  repo,
  selected,
  onSelect,
  onClear,
}: Props) {
  const [pullRequests, setPullRequests] = useState<OpenPr[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const firstResultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fetchOpenPrs()
      .then((items) => {
        if (live) setPullRequests(items);
      })
      .catch(() => {
        if (live) setPullRequests([]);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setQuery("");
  }, [repo]);

  useEffect(() => {
    if (!open || repo === NO_REPO) return;
    let frame = 0;
    let attempts = 0;
    const focusSearch = () => {
      if (searchRef.current) {
        searchRef.current.focus();
        return;
      }
      attempts += 1;
      if (attempts < 5) frame = requestAnimationFrame(focusSearch);
    };
    frame = requestAnimationFrame(focusSearch);
    return () => cancelAnimationFrame(frame);
  }, [open, repo]);

  const matches = matchingPullRequests(pullRequests || [], repo, query);
  const hasRepo = repo !== NO_REPO;

  function choose(pullRequest: OpenPr) {
    onSelect(pullRequest);
    setOpen(false);
  }

  return (
    <Menu.SubmenuRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Menu.SubmenuTrigger className="justify-between gap-3">
        <span className="flex flex-none items-center gap-2">
          <IconPullRequest className="shrink-0 text-dim" size={20} />
          <span>Pull request</span>
        </span>
        <span className="flex min-w-0 items-center gap-1 text-dim">
          <span className="truncate">
            {selected ? `#${selected.number}` : "None"}
          </span>
          <IconChevronRight className="shrink-0 text-faint" size={20} />
        </span>
      </Menu.SubmenuTrigger>
      <Menu.Popup className="w-[min(380px,calc(100vw-1rem))]">
        <Menu.Group>
          <Menu.GroupLabel>Start from</Menu.GroupLabel>
          <Menu.Item onClick={onClear} className="phone:min-h-11">
            <IconNewBranch className="shrink-0 text-dim" size={20} />
            <span className="min-w-0 grow truncate">New branch</span>
            <Menu.Check on={!selected} className="text-dim" />
          </Menu.Item>
        </Menu.Group>
        <Menu.Separator />
        {hasRepo && (
          <div className="px-1.5 pb-1.5">
            <div className="relative">
              <IconSearch
                aria-hidden
                size={20}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
              />
              <Input
                ref={searchRef}
                type="search"
                enterKeyHint="search"
                aria-label="Search pull requests"
                placeholder="Search pull requests…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    event.stopPropagation();
                    firstResultRef.current?.focus();
                  } else if (
                    event.key === "Enter" &&
                    query.trim() &&
                    matches[0]
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    choose(matches[0]);
                  } else if (event.key !== "Escape" && event.key !== "Tab") {
                    event.stopPropagation();
                  }
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="pl-9 phone:min-h-11 phone:text-input-phone"
              />
            </div>
          </div>
        )}
        {pullRequests === null ? (
          <Menu.Item disabled className="phone:min-h-11 text-faint">
            Loading pull requests…
          </Menu.Item>
        ) : !hasRepo ? (
          <Menu.Item disabled className="phone:min-h-11 text-faint">
            Choose a project first
          </Menu.Item>
        ) : matches.length === 0 ? (
          <Menu.Item disabled className="phone:min-h-11 text-faint">
            {query.trim()
              ? "No matching pull requests"
              : "No open pull requests"}
          </Menu.Item>
        ) : (
          matches.map((pullRequest, index) => {
            const active =
              selected?.repo === pullRequest.repo &&
              selected.number === pullRequest.number;
            return (
              <Menu.Item
                key={`${pullRequest.repo}:${pullRequest.number}`}
                ref={index === 0 ? firstResultRef : undefined}
                onClick={() => choose(pullRequest)}
                className={cn(
                  "items-start gap-2.5 py-2 phone:min-h-11",
                  active && "bg-hover",
                )}
              >
                <RepoTile name={pullRequest.repo} size={20} />
                <span className="flex min-w-0 grow flex-col gap-0.5">
                  <span className="truncate text-control-label text-fg">
                    {repoLabel(pullRequest.repo)} #{pullRequest.number}
                  </span>
                  <span className="truncate text-supporting text-faint">
                    {pullRequest.title}
                  </span>
                </span>
                <Menu.Check on={active} className="mt-1 text-dim" />
              </Menu.Item>
            );
          })
        )}
      </Menu.Popup>
    </Menu.SubmenuRoot>
  );
}
