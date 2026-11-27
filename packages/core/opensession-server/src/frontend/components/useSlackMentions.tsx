import React, {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { fuzzyMatch } from "../../shared/fuzzy-match";
import type { SlackMentionUser } from "../../shared/slack-mentions";
import { caretPoint } from "../lib/caret-coords";
import { PHONE_QUERY } from "../lib/breakpoints";
import { mentionContextAt } from "../lib/mention-trigger";
import { cn } from "../ui/cn";
import { FLOATING_OVERLAY_LAYER } from "../ui/popup-classes";
import { UserAvatar } from "./UserAvatar";

const MAX_ROWS = 8;
const POPUP_WIDTH = 280;
const POPUP_MAX_HEIGHT = 320;

/** Workspace people matching what follows the "@", best first. */
export function slackMentionMatches(
  query: string,
  users: ReadonlyArray<SlackMentionUser>,
): SlackMentionUser[] {
  if (!query) return users.slice(0, MAX_ROWS);
  return users
    .map((user) => ({
      user,
      score: fuzzyMatch(query, [user.name, user.realName]),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ROWS)
    .map((row) => row.user);
}

/**
 * "@" autocomplete for Slack people in a plain textarea. Picking a row hands
 * the host the text with "@Name " written in, so it can send Slack's mention
 * token for that person.
 */
export function useSlackMentions({
  value,
  onPick,
  textareaRef,
  users,
}: {
  value: string;
  /** The text with the pick written in, and who was picked. */
  onPick: (value: string, user: SlackMentionUser) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  users: ReadonlyArray<SlackMentionUser>;
}) {
  const [trigger, setTrigger] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const pendingCaret = useRef<number | null>(null);
  // The "@" that Escape closed, or a row was picked for, stays closed until
  // the caret leaves it, so the rest of the sentence is not a search.
  const dismissedAt = useRef<number | null>(null);
  const popupId = useId();

  // A name may hold a space, so the query may too; it ends once nothing
  // matches it any more.
  const matches = trigger ? slackMentionMatches(trigger.query, users) : [];
  const open = !!trigger && matches.length > 0;

  function sync() {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const next = mentionContextAt(el.value, caret);
    if (next?.start !== dismissedAt.current) dismissedAt.current = null;
    const shown = next && dismissedAt.current === null ? next : null;
    setTrigger((prev) =>
      prev?.start === shown?.start && prev?.query === shown?.query
        ? prev
        : shown,
    );
  }

  // Re-read the trigger from the committed value, then put the caret after
  // a pick that just landed.
  const afterValueChange = useEffectEvent(() => {
    sync();
    if (pendingCaret.current == null) return;
    const el = textareaRef.current;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    el?.focus();
    el?.setSelectionRange(caret, caret);
  });
  useEffect(() => {
    afterValueChange();
  }, [value]);

  useEffect(() => {
    setActiveIdx(0);
  }, [trigger?.start, trigger?.query]);

  useLayoutEffect(() => {
    if (!open || !trigger) {
      setPos(null);
      return;
    }
    const measure = () => {
      const caret = caretPoint(textareaRef.current, trigger.start);
      if (!caret) return;
      const gutter = window.matchMedia(PHONE_QUERY).matches ? 16 : 8;
      const width = Math.min(POPUP_WIDTH, window.innerWidth - gutter * 2);
      const left = Math.max(
        gutter,
        Math.min(caret.left - 8, window.innerWidth - width - gutter),
      );
      const spaceAbove = caret.top;
      const spaceBelow = window.innerHeight - caret.bottom;
      const down = spaceAbove < POPUP_MAX_HEIGHT && spaceBelow > spaceAbove;
      setPos({
        left,
        width,
        ...(down
          ? {
              top: caret.bottom + 6,
              maxHeight: Math.min(POPUP_MAX_HEIGHT, spaceBelow - 12),
            }
          : {
              bottom: window.innerHeight - caret.top + 6,
              maxHeight: Math.min(POPUP_MAX_HEIGHT, spaceAbove - 12),
            }),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, trigger, textareaRef]);

  function pick(user: SlackMentionUser) {
    if (!trigger) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, trigger.start);
    const insert = `@${user.name} `;
    pendingCaret.current = before.length + insert.length;
    dismissedAt.current = trigger.start;
    setTrigger(null);
    onPick(before + insert + value.slice(caret), user);
  }

  /** True when the key belonged to the open picker. */
  function handleKeyDown(event: React.KeyboardEvent): boolean {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIdx((i) => (i + step + matches.length) % matches.length);
      return true;
    }
    if (
      (event.key === "Enter" && !(event.metaKey || event.ctrlKey)) ||
      event.key === "Tab"
    ) {
      event.preventDefault();
      pick(matches[Math.min(activeIdx, matches.length - 1)]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismissedAt.current = trigger?.start ?? null;
      setTrigger(null);
      return true;
    }
    return false;
  }

  const popup =
    open && pos
      ? createPortal(
          <div
            className={cn(
              "fixed overflow-y-auto rounded-xl bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] p-1 smooth-shadow-ring-md",
              FLOATING_OVERLAY_LAYER,
            )}
            id={popupId}
            role="listbox"
            aria-label="Slack people"
            style={pos}
          >
            {matches.map((user, i) => (
              <div
                key={user.id}
                role="option"
                id={`${popupId}-option-${i}`}
                aria-selected={i === activeIdx}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-control px-2.5 py-2 text-label leading-tight whitespace-nowrap phone:min-h-11",
                  i === activeIdx && "bg-pressed",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(user);
                }}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <UserAvatar name={user.name} image={user.image} size={20} />
                <span className="shrink-0 font-medium text-fg">
                  {user.name}
                </span>
                {user.realName && (
                  <span className="overflow-hidden text-ellipsis text-meta text-faint">
                    {user.realName}
                  </span>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )
      : null;

  const inputProps: Pick<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    | "role"
    | "aria-autocomplete"
    | "aria-expanded"
    | "aria-controls"
    | "aria-activedescendant"
  > = {
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": open,
  };
  if (open) {
    inputProps["aria-controls"] = popupId;
    inputProps["aria-activedescendant"] = `${popupId}-option-${activeIdx}`;
  }

  return {
    popup,
    open,
    inputProps,
    sync,
    handleKeyDown,
    close: () => setTrigger(null),
  };
}
