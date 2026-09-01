import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useEffect, useRef, useState } from "react";
import { fetchOpenPrs, type OpenPr } from "../lib/api";
import { matchingPullRequests } from "../lib/new-session-prs";
import { paletteIconBtn } from "../lib/palette-classes";
import { NO_REPO } from "../lib/session-repo";
import { cn } from "../ui/cn";
import { Input } from "../ui/input";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { IconNewBranch, IconPullRequest, IconSearch } from "./icons";
import { RepoTile, repoLabel } from "./RepoTile";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  wMin380pxCalc100vw1rem: {
    width: "min(380px, calc(100vw - 1rem))",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  textDim: {
    color: "var(--text-dim)",
  },
  minW0: {
    minWidth: "0",
  },
  grow: {
    flexGrow: "1",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  pb15: {
    paddingBottom: "calc(4px * 1.5)",
  },
  relative: {
    position: "relative",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  left25: {
    left: "calc(4px * 2.5)",
  },
  top12: {
    top: "calc(1 / 2 * 100%)",
  },
  TranslateY12: {
    translate: "0 calc(calc(1 / 2 * 100%) * -1)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  pl9: {
    paddingLeft: "calc(4px * 9)",
  },
  phoneTextInputPhone: {
    "@media (max-width: 720px)": {
      fontSize: "var(--type-input-phone)",
    },
  },
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt1: {
    marginTop: "4px",
  },
});

interface Props {
  repo: string;
  selected: OpenPr | null;
  disabled?: boolean;
  onSelect: (pullRequest: OpenPr) => void;
  onClear: () => void;
}

/**
 * The new-session composer's PR source picker. The parent owns the selected
 * start point; this component only owns the cached open-PR list and its menu.
 */
export function NewSessionPrPicker({
  repo,
  selected,
  disabled,
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
  const label = selected
    ? `PR #${selected.number}`
    : "Start from a pull request";

  function choose(pullRequest: OpenPr) {
    onSelect(pullRequest);
    setOpen(false);
  }

  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Tooltip label={label}>
        <Menu.Trigger
          type="button"
          className={cn(
            selected
              ? utilityClassName(
                  "inline-flex min-h-8 max-w-[130px] shrink-0 items-center gap-1.5 rounded-control bg-accent-soft px-2.5 text-label font-medium text-accent transition-[background,color] hover:bg-hover disabled:cursor-default disabled:opacity-50 phone:min-h-11 phone:max-w-[112px] phone:rounded-[999px] phone:px-3",
                )
              : cn(
                  paletteIconBtn,
                  utilityClassName(
                    "shrink-0 phone:size-11 phone:rounded-[999px] phone:before:rounded-[999px]",
                  ),
                ),
          )}
          disabled={disabled}
          aria-label={label}
        >
          <IconPullRequest
            className={mergeStylexOverrideClassName("", sx.shrink0)}
            size={20}
          />
          {selected && (
            <span {...stylex.props(sx.truncate)}>#{selected.number}</span>
          )}
        </Menu.Trigger>
      </Tooltip>
      <Menu.Popup
        align="start"
        sideOffset={6}
        className={mergeStylexOverrideClassName("", sx.wMin380pxCalc100vw1rem)}
      >
        <Menu.Group>
          <Menu.GroupLabel>Start from</Menu.GroupLabel>
          <Menu.Item
            onClick={onClear}
            className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
          >
            <IconNewBranch
              className={mergeStylexOverrideClassName(
                "",
                sx.shrink0,
                sx.textDim,
              )}
              size={20}
            />
            <span {...stylex.props(sx.minW0, sx.grow, sx.truncate)}>
              New branch
            </span>
            <Menu.Check
              on={!selected}
              className={mergeStylexOverrideClassName("", sx.textDim)}
            />
          </Menu.Item>
        </Menu.Group>
        <Menu.Separator />
        {hasRepo && (
          <div {...stylex.props(sx.px15, sx.pb15)}>
            <div {...stylex.props(sx.relative)}>
              <IconSearch
                aria-hidden
                size={16}
                className={mergeStylexOverrideClassName(
                  "",
                  sx.pointerEventsNone,
                  sx.absolute,
                  sx.left25,
                  sx.top12,
                  sx.TranslateY12,
                  sx.textFaint,
                )}
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
                className={mergeStylexOverrideClassName(
                  "",
                  sx.pl9,
                  sx.phoneMinH11,
                  sx.phoneTextInputPhone,
                )}
              />
            </div>
          </div>
        )}
        {pullRequests === null ? (
          <Menu.Item
            disabled
            className={mergeStylexOverrideClassName(
              "",
              sx.phoneMinH11,
              sx.textFaint,
            )}
          >
            Loading pull requests…
          </Menu.Item>
        ) : !hasRepo ? (
          <Menu.Item
            disabled
            className={mergeStylexOverrideClassName(
              "",
              sx.phoneMinH11,
              sx.textFaint,
            )}
          >
            Choose a project first
          </Menu.Item>
        ) : matches.length === 0 ? (
          <Menu.Item
            disabled
            className={mergeStylexOverrideClassName(
              "",
              sx.phoneMinH11,
              sx.textFaint,
            )}
          >
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
                  utilityClassName("items-start gap-2.5 py-2 phone:min-h-11"),
                  active && utilityClassName("bg-hover"),
                )}
              >
                <RepoTile name={pullRequest.repo} size={20} />
                <span
                  {...stylex.props(
                    sx.flex,
                    sx.minW0,
                    sx.grow,
                    sx.flexCol,
                    sx.gap05,
                  )}
                >
                  <span
                    {...stylex.props(
                      sx.truncate,
                      sx.textFg,
                      typography.controlLabel,
                    )}
                  >
                    {repoLabel(pullRequest.repo)} #{pullRequest.number}
                  </span>
                  <span
                    {...stylex.props(
                      sx.truncate,
                      sx.textFaint,
                      typography.supporting,
                    )}
                  >
                    {pullRequest.title}
                  </span>
                </span>
                <Menu.Check
                  on={active}
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.mt1,
                    sx.textDim,
                  )}
                />
              </Menu.Item>
            );
          })
        )}
      </Menu.Popup>
    </Menu.Root>
  );
}
