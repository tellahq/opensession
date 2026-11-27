import { relativeTime } from "../lib/api";
import { isAutomationSession } from "../lib/landing-session";
import type { UnifiedSession } from "../lib/types";
import { Menu } from "../ui/menu";
import { IconRestore, IconRobot } from "./icons";

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
              size={20}
              className="shrink-0 text-faint"
              aria-label="Agent run"
            />
          )}
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          <span className="shrink-0 text-meta text-faint">
            {relativeTime(s.lastActivity)}
          </span>
          <button
            type="button"
            className="flex shrink-0 cursor-pointer items-center rounded-control border-0 bg-transparent p-0.5 text-dim hover:text-fg"
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
