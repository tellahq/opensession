import React from "react";
import type {
  UnifiedSession,
  WSClientMessage,
  WSServerMessage,
} from "../lib/types";
import { PrPanel } from "./PrPanel";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  hFull: {
    height: "100%",
  },
  minH0: {
    minHeight: "0",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
});

interface Props {
  repo: string;
  branch: string;
  sessions: UnifiedSession[];
  onOpenSession: (id: string) => void;
  /** Open another PR in the review panel (stack map layer links). */
  onOpenPr?: (repo: string, branch: string) => void;
  send?: (msg: WSClientMessage) => void;
  addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * Review-canvas adapter for PRs opened from the sidebar queue. A primary-branch
 * session uses the normal session APIs; an unclaimed PR uses the repo+branch
 * preview APIs, but both render the exact same review surface.
 */
export function PrQueuePreview({
  repo,
  branch,
  sessions,
  onOpenSession,
  onOpenPr,
  send,
  addHandler,
}: Props) {
  const session =
    [...sessions]
      .filter((item) => item.repo === repo && item.branch === branch)
      .sort((a, b) =>
        (b.lastActivity || "").localeCompare(a.lastActivity || ""),
      )[0] || null;

  return (
    <div {...stylex.props(sx.hFull, sx.minH0, sx.bgSurface)}>
      <PrPanel
        onOpenPr={onOpenPr}
        sessionId={session?.id || ""}
        previewTarget={session ? undefined : { repo, branch }}
        send={send}
        addHandler={addHandler}
        sessions={sessions}
        onOpenSessionById={onOpenSession}
        onOpenSession={session ? () => onOpenSession(session.id) : undefined}
        walkthrough={session?.walkthrough}
      />
    </div>
  );
}
