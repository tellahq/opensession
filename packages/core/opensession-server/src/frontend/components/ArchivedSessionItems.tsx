import { mergeStylexOverrideClassName } from "../ui/cn";
import { relativeTime } from "../lib/api";
import { isAutomationSession } from "../lib/landing-session";
import type { UnifiedSession } from "../lib/types";
import { Menu } from "../ui/menu";
import { IconRestore, IconRobot } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  flex: {
    display: "flex",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  itemsCenter: {
    alignItems: "center",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  p05: {
    padding: "calc(4px * 0.5)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
});

interface Props {
  /** Closed sessions of one workspace, newest activity first. */
  sessions: UnifiedSession[];
  /** Open a closed session — it gets a tab for as long as it's viewed. */
  onSelect: (session: UnifiedSession) => void;
  /** Un-archive it back into the strip for good. */
  onRestore: (session: UnifiedSession) => void;
}

/**
 * The rows of a workspace's archived-sessions menu. Two surfaces show the same
 * list, so it lives here rather than in either of them: the tab strip's history
 * button, and the session header's ⋯ menu when a lone session leaves no strip
 * to hang that button on.
 *
 * A workspace closes far more agent runs than conversations — review runs,
 * auto-fixes, the workers a session spawned — so those carry a robot and the
 * rest of the list reads as the sessions people actually had.
 */
export function ArchivedSessionItems({ sessions, onSelect, onRestore }: Props) {
  return (
    <>
      {sessions.map((s) => (
        <Menu.Item key={s.id} onClick={() => onSelect(s)}>
          {(isAutomationSession(s) || !!s.parentSessionId) && (
            <IconRobot
              size={14}
              className={mergeStylexOverrideClassName(
                "",
                sx.shrink0,
                sx.textFaint,
              )}
              aria-label="Agent run"
            />
          )}
          <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
            {s.title}
          </span>
          <span {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}>
            {relativeTime(s.lastActivity)}
          </span>
          <button
            type="button"
            {...stylex.props(
              sx.flex,
              sx.shrink0,
              sx.cursorPointer,
              sx.itemsCenter,
              sx.roundedControl,
              sx.border0,
              sx.bgTransparent,
              sx.p05,
              sx.textDim,
              sx.hoverTextFg,
            )}
            aria-label="Restore session"
            title="Restore to tabs"
            onClick={(e) => {
              e.stopPropagation();
              onRestore(s);
            }}
          >
            <IconRestore size={20} />
          </button>
        </Menu.Item>
      ))}
    </>
  );
}
