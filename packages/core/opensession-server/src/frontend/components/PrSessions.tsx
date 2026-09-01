import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useEffect, useRef, useState } from "react";
import type {
  UnifiedSession,
  WSClientMessage,
  WSServerMessage,
} from "../lib/types";
import { relativeTime } from "../lib/api";
import { sessionPath } from "../lib/share-link";
import { Button } from "../ui/button";
import { getCurrentUser } from "./UserPicker";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  Mx2: {
    marginInline: "calc(4px * -2)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  textFg: {
    color: "var(--text)",
  },
  noUnderline: {
    textDecorationLine: "none",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  shrink0: {
    flexShrink: "0",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  phoneFlexCol: {
    "@media (max-width: 720px)": {
      flexDirection: "column",
    },
  },
  phoneItemsStretch: {
    "@media (max-width: 720px)": {
      alignItems: "stretch",
    },
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  mt15: {
    marginTop: "calc(4px * 1.5)",
  },
  textRed: {
    color: "var(--red)",
  },
});

/**
 * Sessions related to a PR: primarily via the server-enriched `prs` refs
 * (primary + attached + linked), with primary-branch/number fallbacks for
 * sessions the enrichment hasn't reached. Matching also uses the loaded PR's
 * number and head branch, so number-keyed callers link the same sessions as
 * branch-keyed ones. Legacy hidden sessions are excluded; running sessions sort first,
 * then most recent activity.
 */
export function prRelatedSessions(
  sessions: UnifiedSession[],
  repo: string,
  branch: string | undefined,
  pr?: { number?: number; headRefName?: string } | null,
): UnifiedSession[] {
  const num = pr?.number;
  const head = pr?.headRefName;
  const refMatch = (r: { repo: string; branch?: string; number?: number }) =>
    r.repo === repo &&
    ((num != null && r.number === num) ||
      (!!branch && r.branch === branch) ||
      (!!head && r.branch === head));
  const matched = sessions.filter((s) => {
    if ((s.prs || []).some(refMatch)) return true;
    if ((s.linkedPrs || []).some(refMatch)) return true;
    const sRepo = s.repo || "repository";
    if (
      sRepo === repo &&
      ((!!branch && s.branch === branch) || (!!head && s.branch === head))
    )
      return true;
    if (num != null && sRepo === repo && s.prNumber === num) return true;
    return (s.attachedRepos || []).some(
      (a) =>
        a.repo === repo &&
        ((!!branch && a.branch === branch) || (!!head && a.branch === head)),
    );
  });
  return matched.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return (b.lastActivity || "").localeCompare(a.lastActivity || "");
  });
}

interface Props {
  /** Already-matched sessions for this PR (see prRelatedSessions). */
  sessions: UnifiedSession[];
  repo: string;
  /** The PR's head branch as the caller knows it (the loaded PR's headRefName wins). */
  branch?: string;
  pr?: { number?: number; title?: string; headRefName?: string } | null;
  /** Marks this session's row as "current" (the session hosting the panel). */
  currentSessionId?: string;
  onOpenSession?: (id: string) => void;
  /** WebSocket sender + handler hook — both required for the compose form. */
  send?: (msg: WSClientMessage) => void;
  addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
  /** Offer the inline "start a new session on this PR" form. */
  compose?: boolean;
}

/**
 * The sessions linked to a PR, with an optional one-line composer that starts
 * a NEW session on the PR's head branch (`create_session` with `fromPr` — an
 * isolated worktree checking out the existing branch). The new session joins the
 * PR's existing workspace when a related session carries one; otherwise a
 * fresh workspace named after the PR is minted (the PrPreview pattern). App
 * navigates into the session on `session_created`.
 */
export function PrSessionsList({
  sessions,
  repo,
  branch,
  pr,
  currentSessionId,
  onOpenSession,
  send,
  addHandler,
  compose,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Success navigates away on session_created (App handles it); on failure
  // the `starting` lock would stick — reset on server error or timeout (same
  // pattern as PrPreview / the workspace home composer).
  useEffect(() => {
    if (!addHandler) return;
    return addHandler((msg) => {
      if (msg.type === "error" && startingRef.current) {
        clearTimeout(timer.current);
        startingRef.current = false;
        setStarting(false);
        setError(msg.message || "Failed to start the session.");
      }
    });
  }, [addHandler]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const targetBranch = pr?.headRefName || branch;
  const canCompose = !!compose && !!send && !!targetBranch;

  function handleStart() {
    const q = prompt.trim();
    if (!q || starting || !send || !targetBranch) return;
    setStarting(true);
    startingRef.current = true;
    setError(null);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!startingRef.current) return;
      startingRef.current = false;
      setStarting(false);
      setError("No response. Check your connection and try again.");
    }, 15_000);
    // Join the PR's existing workspace when a related session carries one so
    // the new session lands as a sibling tab, not a duplicate workspace.
    const workspaceId =
      sessions.find((s) => s.workspaceId)?.workspaceId || undefined;
    send({
      type: "create_session",
      mode: "code",
      repo,
      branch: targetBranch,
      fromPr: true,
      prompt: q,
      user: getCurrentUser(),
      ...(workspaceId
        ? { workspaceId }
        : {
            createWorkspace: {
              name: pr?.number
                ? `PR #${pr.number}: ${pr.title || ""}`.trim().slice(0, 80)
                : targetBranch,
            },
          }),
    });
    // App navigates into the session on session_created.
  }

  return (
    <div {...stylex.props(sx.flex, sx.flexCol)}>
      {sessions.length === 0 && (
        <div
          {...stylex.props(
            sx.Mx2,
            sx.px2,
            sx.py15,
            sx.textFaint,
            typography.supporting,
          )}
        >
          No sessions yet.
        </div>
      )}
      {sessions.map((s) => (
        <a
          key={s.id}
          href={sessionPath(s)}
          onClick={(e) => {
            // Plain click navigates in-app; modified clicks keep native
            // new-tab behavior.
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            onOpenSession?.(s.id);
          }}
          {...stylex.props(
            sx.Mx2,
            sx.flex,
            sx.minH10,
            sx.itemsCenter,
            sx.gap2,
            sx.roundedControl,
            sx.px2,
            sx.py15,
            sx.textFg,
            sx.noUnderline,
            sx.hoverBgHover,
            sx.phoneMinH11,
            typography.itemTitle,
          )}
        >
          <span
            className={utilityClassName(
              `w-1.5 h-1.5 rounded-full shrink-0 ${
                s.isRunning ? "bg-yellow animate-pulse" : "bg-line"
              }`,
            )}
          />
          <span {...stylex.props(sx.truncate)}>{s.title}</span>
          {s.id === currentSessionId && (
            <Badge variant="outline">current</Badge>
          )}
          {s.archived && (
            <span {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}>
              archived
            </span>
          )}
          {s.startedBy && (
            <span {...stylex.props(sx.textFaint, sx.shrink0, typography.label)}>
              {s.startedBy}
            </span>
          )}
          <span
            {...stylex.props(
              sx.textFaint,
              sx.shrink0,
              sx.mlAuto,
              typography.label,
            )}
          >
            {relativeTime(s.lastActivity)}
          </span>
        </a>
      ))}
      {canCompose && (
        <form
          {...stylex.props(
            sx.mt3,
            sx.flex,
            sx.itemsCenter,
            sx.gap2,
            sx.phoneFlexCol,
            sx.phoneItemsStretch,
          )}
          onSubmit={(e) => {
            e.preventDefault();
            handleStart();
          }}
        >
          <Input
            className={mergeStylexOverrideClassName(
              "",
              sx.minW0,
              sx.flex1,
              sx.phoneMinH11,
            )}
            placeholder="What should this session do?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={starting}
          />
          <Button
            type="submit"
            variant="primary"
            className={mergeStylexOverrideClassName(
              "",
              sx.shrink0,
              sx.textXs,
              sx.phoneMinH11,
            )}
            disabled={starting || !prompt.trim()}
          >
            {starting ? "Starting…" : "Start"}
          </Button>
        </form>
      )}
      {error && (
        <div {...stylex.props(sx.mt15, sx.textXs, sx.textRed)}>{error}</div>
      )}
    </div>
  );
}
