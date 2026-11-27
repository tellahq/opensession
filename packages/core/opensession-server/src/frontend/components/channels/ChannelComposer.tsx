import { useRef, useState, type ReactNode } from "react";
import {
  encodeSlackMentions,
  type SlackMentionUser,
} from "../../../shared/slack-mentions";
import { fetchSlackUsers } from "../../lib/api/shipped-changes";
import {
  applyFormat,
  mentionContextAt,
  type FormatKind,
} from "../../lib/channel-format";
import { noAutofill } from "../../lib/composer-autofill";
import { readDraft, saveDraft } from "../../lib/channel-drafts";
import { emojiContextAt, emojiMatches, type EmojiEntry } from "../../lib/emoji";
import { isApple } from "../../lib/platform";
import { effectiveSendKey, isSendCombo } from "../../lib/send-key";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { Tooltip } from "../../ui/tooltip";
import {
  IconAtSign,
  IconBold,
  IconCode,
  IconCodeBlock,
  IconItalic,
  IconLink,
  IconListBullet,
  IconListOrdered,
  IconQuote,
  IconSend,
  IconSmile,
  IconStrikethrough,
} from "../icons";
import { UserAvatar } from "../UserAvatar";
import { EmojiPicker } from "./EmojiPicker";

const MOD = isApple ? "⌘" : "Ctrl";

const FORMATS: (
  | { kind: FormatKind; label: string; icon: ReactNode; keys?: string[] }
  | "|"
)[] = [
  {
    kind: "bold",
    label: "Bold",
    icon: <IconBold size={20} />,
    keys: [MOD, "B"],
  },
  {
    kind: "italic",
    label: "Italic",
    icon: <IconItalic size={20} />,
    keys: [MOD, "I"],
  },
  {
    kind: "strike",
    label: "Strikethrough",
    icon: <IconStrikethrough size={20} />,
    keys: [MOD, "⇧", "X"],
  },
  "|",
  { kind: "link", label: "Link", icon: <IconLink size={20} /> },
  "|",
  {
    kind: "ordered",
    label: "Ordered list",
    icon: <IconListOrdered size={20} />,
  },
  {
    kind: "bullet",
    label: "Bulleted list",
    icon: <IconListBullet size={20} />,
  },
  "|",
  { kind: "quote", label: "Quote", icon: <IconQuote size={20} /> },
  { kind: "code", label: "Code", icon: <IconCode size={20} /> },
  { kind: "codeblock", label: "Code block", icon: <IconCodeBlock size={20} /> },
];

type Suggestion =
  | { kind: "person"; user: SlackMentionUser }
  | { kind: "emoji"; entry: EmojiEntry };

// Slack's "Aa": the formatting row's show and hide toggle.
const FORMATTING_GLYPH = (
  <span className="text-body font-medium underline underline-offset-2">Aa</span>
);

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-divider" aria-hidden />;
}

/**
 * The box under a channel or a thread, laid out like Slack's: the formatting
 * row on top (Aa hides it), the text, then emoji and mention buttons and the
 * paper plane. Formatting is written as Slack's own markup, "@name" picks a
 * teammate and ":name" an emoji. Enter sends on a keyboard; a touch keyboard
 * has no Shift+Enter, so there it is the send button.
 */
export function ChannelComposer({
  placeholder,
  disabled,
  disabledHint,
  broadcastLabel,
  onSend,
  autoFocus,
  draftOf,
  compact = false,
}: {
  placeholder: string;
  disabled: boolean;
  /** Shown instead of the placeholder while disabled. */
  disabledHint?: string;
  /** In a thread: the label of "also send to the channel". */
  broadcastLabel?: string;
  onSend: (text: string, broadcast: boolean) => Promise<boolean>;
  autoFocus?: boolean;
  /** Keep what is typed as this conversation's (or thread's) draft. */
  draftOf?: { channelId: string; thread?: string };
  /** Start with the formatting row hidden, for a box among other content. */
  compact?: boolean;
}) {
  const [stored] = useState(() =>
    draftOf ? readDraft(draftOf.channelId, draftOf.thread) : undefined,
  );
  const [draft, setDraftText] = useState(stored?.text ?? "");
  const [sending, setSending] = useState(false);
  const [broadcast, setBroadcast] = useState(false);
  const [formatting, setFormatting] = useState(!compact);
  const [users, setUsers] = useState<SlackMentionUser[]>([]);
  // The people picked from the "@" list, by the name the text shows.
  const [mentions, setMentions] = useState<Map<string, string>>(
    () => new Map(stored?.mentions),
  );
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState(-1);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const sendKey = effectiveSendKey("enter");
  const canSend = !disabled && !sending && !!draft.trim();

  const mention = mentionContextAt(draft, caret);
  const emoji = mention ? null : emojiContextAt(draft, caret);
  const context = mention ?? emoji;
  const suggestions: Suggestion[] =
    context && context.start !== dismissedAt
      ? mention
        ? users
            .filter((user) => {
              const q = mention.query.toLowerCase();
              return (
                user.name.toLowerCase().includes(q) ||
                !!user.realName?.toLowerCase().includes(q)
              );
            })
            .slice(0, 6)
            .map((user) => ({ kind: "person" as const, user }))
        : emojiMatches(emoji!.query)
            .slice(0, 6)
            .map((entry) => ({ kind: "emoji" as const, entry }))
      : [];
  const active = suggestions[Math.min(highlight, suggestions.length - 1)];

  function setDraft(value: string, picked: Map<string, string> = mentions) {
    setDraftText(value);
    if (draftOf) saveDraft(draftOf.channelId, draftOf.thread, value, picked);
  }

  function loadPeople() {
    if (users.length) return;
    void fetchSlackUsers().then(setUsers);
  }

  function setText(
    value: string,
    start: number,
    end = start,
    picked: Map<string, string> = mentions,
  ) {
    setDraft(value, picked);
    setCaret(end);
    requestAnimationFrame(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, end);
    });
  }

  function insert(text: string) {
    const el = textRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const value = draft.slice(0, start) + text + draft.slice(end);
    setText(value, start + text.length);
  }

  function format(kind: FormatKind) {
    const el = textRef.current;
    const next = applyFormat(
      {
        value: draft,
        start: el?.selectionStart ?? draft.length,
        end: el?.selectionEnd ?? draft.length,
      },
      kind,
    );
    setText(next.value, next.start, next.end);
  }

  function pick(suggestion: Suggestion) {
    if (!context) return;
    const replacement =
      suggestion.kind === "person"
        ? `@${suggestion.user.name} `
        : suggestion.entry.char;
    const picked =
      suggestion.kind === "person"
        ? new Map(mentions).set(suggestion.user.name, suggestion.user.id)
        : mentions;
    if (picked !== mentions) setMentions(picked);
    const value =
      draft.slice(0, context.start) + replacement + draft.slice(caret);
    setHighlight(0);
    setText(value, context.start + replacement.length, undefined, picked);
  }

  async function send() {
    const text = draft.trim();
    if (!canSend) return;
    setSending(true);
    const sent = await onSend(encodeSlackMentions(text, mentions), broadcast);
    setSending(false);
    if (sent) {
      setDraft("", new Map());
      setCaret(0);
      setBroadcast(false);
      setMentions(new Map());
    }
  }

  return (
    <div className="relative">
      {suggestions.length > 0 && (
        <div
          role="listbox"
          aria-label={mention ? "People" : "Emoji"}
          className="absolute right-0 bottom-full left-0 z-20 mb-1 flex flex-col gap-0.5 rounded-popup bg-panel p-1 shadow-ring-md"
        >
          {suggestions.map((suggestion, index) => (
            <ListRow
              key={
                suggestion.kind === "person"
                  ? suggestion.user.id
                  : suggestion.entry.name
              }
              role="option"
              aria-selected={suggestion === active}
              className={cn(
                "min-h-0 items-center gap-2 px-2 py-1.5 text-body",
                suggestion === active && "bg-hover",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(suggestion)}
            >
              {suggestion.kind === "person" ? (
                <>
                  <UserAvatar
                    name={suggestion.user.name}
                    image={suggestion.user.image}
                    size={20}
                    className="rounded-sm"
                  />
                  <span className="font-medium text-fg">
                    {suggestion.user.name}
                  </span>
                  {suggestion.user.realName &&
                    suggestion.user.realName !== suggestion.user.name && (
                      <span className="truncate text-meta text-faint">
                        {suggestion.user.realName}
                      </span>
                    )}
                </>
              ) : (
                <>
                  <span className="text-dialog-title">
                    {suggestion.entry.char}
                  </span>
                  <span className="text-dim">:{suggestion.entry.name}:</span>
                </>
              )}
            </ListRow>
          ))}
        </div>
      )}
      {/* `composer` stays as a hook: base.css keys phone keyboard behaviour
          off the class name. */}
      <div
        className={cn(
          "composer flex flex-col rounded-lg border border-line bg-surface transition-colors focus-within:border-line-strong",
          disabled && "opacity-60",
        )}
      >
        {formatting && (
          <div
            role="toolbar"
            aria-label="Formatting"
            className="flex items-center gap-0.5 overflow-x-auto px-1.5 pt-1.5 [scrollbar-width:none]"
          >
            {FORMATS.map((item, index) =>
              item === "|" ? (
                <Divider key={index} />
              ) : (
                <Tooltip
                  key={item.kind}
                  label={item.label}
                  shortcut={item.keys}
                >
                  <Button
                    variant="ghost"
                    size="md"
                    icon={item.icon}
                    aria-label={item.label}
                    disabled={disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => format(item.kind)}
                  />
                </Tooltip>
              ),
            )}
          </div>
        )}
        <textarea
          ref={textRef}
          // `composer-textarea` stays as a class name hook (the sidebar swipe
          // guard and SessionViewer's global keys look for it).
          className="composer-textarea max-h-[40vh] min-h-11 w-full resize-none border-none bg-transparent px-3.5 py-2.5 text-body leading-relaxed text-fg outline-none [field-sizing:content] placeholder:text-faint phone:text-[length:var(--text-input-phone)]"
          placeholder={disabled && disabledHint ? disabledHint : placeholder}
          value={draft}
          disabled={disabled}
          autoFocus={autoFocus}
          rows={1}
          aria-label={placeholder}
          onFocus={loadPeople}
          onChange={(event) => {
            setDraft(event.target.value);
            setCaret(event.target.selectionStart);
            setHighlight(0);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (suggestions.length) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setHighlight(
                  (highlight + step + suggestions.length) % suggestions.length,
                );
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && active) {
                event.preventDefault();
                pick(active);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedAt(context!.start);
                return;
              }
            }
            const mod = event.metaKey || event.ctrlKey;
            if (mod && !event.shiftKey && event.key.toLowerCase() === "b") {
              event.preventDefault();
              format("bold");
              return;
            }
            if (mod && !event.shiftKey && event.key.toLowerCase() === "i") {
              event.preventDefault();
              format("italic");
              return;
            }
            if (mod && event.shiftKey && event.key.toLowerCase() === "x") {
              event.preventDefault();
              format("strike");
              return;
            }
            if (isSendCombo(event, sendKey)) {
              event.preventDefault();
              void send();
            }
          }}
          {...noAutofill}
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <Tooltip label={formatting ? "Hide formatting" : "Show formatting"}>
            <Button
              variant="ghost"
              size="md"
              aria-label={formatting ? "Hide formatting" : "Show formatting"}
              aria-pressed={formatting}
              icon={FORMATTING_GLYPH}
              onClick={() => setFormatting(!formatting)}
            />
          </Tooltip>
          <EmojiPicker
            align="start"
            tooltip="Emoji"
            onPick={(entry) => insert(entry.char)}
            trigger={
              <Button
                variant="ghost"
                size="md"
                icon={<IconSmile size={22} />}
                aria-label="Emoji"
                disabled={disabled}
              />
            }
          />
          <Tooltip label="Mention someone">
            <Button
              variant="ghost"
              size="md"
              icon={<IconAtSign size={22} />}
              aria-label="Mention someone"
              disabled={disabled}
              onClick={() => {
                loadPeople();
                setDismissedAt(-1);
                const before = draft.slice(0, caret);
                insert(before && !/\s$/.test(before) ? " @" : "@");
              }}
            />
          </Tooltip>
          <div className="min-w-0 flex-1" />
          <Tooltip label="Send now" shortcut={["↵"]}>
            <Button
              variant={canSend ? "success-strong" : "ghost"}
              size="md"
              icon={<IconSend size={22} />}
              aria-label="Send message"
              disabled={!canSend}
              onClick={() => void send()}
            />
          </Tooltip>
        </div>
      </div>
      {broadcastLabel && (
        <label className="mt-2 flex min-h-8 cursor-pointer items-center gap-2 pl-1 text-meta text-dim select-none phone:min-h-11">
          <Checkbox
            checked={broadcast}
            onCheckedChange={(checked) => setBroadcast(checked === true)}
            disabled={disabled}
          />
          {broadcastLabel}
        </label>
      )}
    </div>
  );
}
