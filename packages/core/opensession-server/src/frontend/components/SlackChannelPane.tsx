import { mergeStylexProps } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import {
  composerBox,
  composerBoxExpanded,
  composerSend,
  composerSendDefault,
  composerTextarea,
  composerTextareaPadding,
  composerToolbar,
} from "../lib/composer-classes";
import { noAutofill } from "../lib/composer-autofill";
import { IconArrowUp } from "./icons";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  inlineBlock: {
    display: "inline-block",
  },
  h18px: {
    height: "18px",
  },
  w18px: {
    width: "18px",
  },
  alignTextBottom: {
    verticalAlign: "text-bottom",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgAccentSoft: {
    backgroundColor: "var(--accent-soft)",
  },
  px1: {
    paddingInline: "4px",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textLink: {
    color: "var(--link)",
  },
  underline: {
    textDecorationLine: "underline",
  },
  decorationLine: {
    textDecorationColor: "var(--border)",
  },
  underlineOffset2: {
    textUnderlineOffset: "2px",
  },
  hoverDecorationCurrent: {
    "@media (hover: hover)": {
      ":hover": {
        textDecorationColor: "currentcolor",
      },
    },
  },
  selectText: {
    WebkitUserSelect: "text",
    userSelect: "text",
  },
  whitespacePreWrap: {
    whiteSpace: "pre-wrap",
  },
  breakWords: {
    overflowWrap: "break-word",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt1: {
    marginTop: "4px",
  },
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gap1: {
    gap: "4px",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py05: {
    paddingBlock: "calc(4px * 0.5)",
  },
  leadingNone: {
    lineHeight: "1",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  h14px: {
    height: "14px",
  },
  w14px: {
    width: "14px",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  h7: {
    height: "calc(4px * 7)",
  },
  w7: {
    width: "calc(4px * 7)",
  },
  flexShrink0: {
    flexShrink: "0",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  hoverUnderline: {
    "@media (hover: hover)": {
      ":hover": {
        textDecorationLine: "underline",
      },
    },
  },
  borderL2: {
    borderLeftStyle: "solid",
    borderLeftWidth: "2px",
  },
  pl3: {
    paddingLeft: "calc(4px * 3)",
  },
  py1: {
    paddingBlock: "4px",
  },
  minH0: {
    minHeight: "0",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  mxAuto: {
    marginInline: "auto",
  },
  wFull: {
    width: "100%",
  },
  maxW760px: {
    maxWidth: "760px",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  py8: {
    paddingBlock: "calc(4px * 8)",
  },
  textCenter: {
    textAlign: "center",
  },
  textSm: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-sm--line-height))",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  textRed: {
    color: "var(--red)",
  },
  maxWCalcVarSessionCol40px: {
    maxWidth: "calc(var(--session-col) + 40px)",
  },
  shrink0: {
    flexShrink: "0",
  },
  pt1: {
    paddingTop: "4px",
  },
  pb4: {
    paddingBottom: "calc(4px * 4)",
  },
  grow: {
    flexGrow: "1",
  },
  basis0: {
    flexBasis: "0",
  },
});

interface MessageReaction {
  name: string;
  count: number;
  /** Unicode char for standard emoji. */
  emoji?: string;
  /** Image URL for custom workspace emoji. */
  url?: string;
}

interface ChannelMessage {
  ts: string;
  userName: string;
  avatarUrl?: string;
  text: string;
  isBot: boolean;
  replyCount?: number;
  reactions?: MessageReaction[];
}

/** Markdown-lite renderer for slack text the route emits: ![:name:](url)
 *  custom-emoji images, [label](url) links, [[@Name]]/[[#chan]] mention
 *  chips, bare URLs — everything else as selectable text. */
function MessageText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re =
    /!\[([^\]]*)\]\((https?:[^)\s]+)\)|\[([^\]]+)\]\((https?:[^)\s]+)\)|\[\[([@#][^\]]+)\]\]|(https?:\/\/[^\s<>]+[^\s<>.,)\]}])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      // Custom emoji image, sized to ride inline with the text.
      parts.push(
        <img
          key={key++}
          src={m[2]}
          alt={m[1]}
          title={m[1]}
          {...stylex.props(
            sx.inlineBlock,
            sx.h18px,
            sx.w18px,
            sx.alignTextBottom,
          )}
        />,
      );
    } else if (m[5] !== undefined) {
      parts.push(
        <span
          key={key++}
          {...mergeStylexProps(
            "text-accent",
            sx.roundedSm,
            sx.bgAccentSoft,
            sx.px1,
            sx.fontMedium,
          )}
        >
          {m[5]}
        </span>,
      );
    } else {
      const href = m[4] || m[6];
      const label = m[3] || m[6];
      parts.push(
        <a
          key={key++}
          href={href}
          target="_blank"
          rel="noreferrer"
          {...stylex.props(
            sx.textLink,
            sx.underline,
            sx.decorationLine,
            sx.underlineOffset2,
            sx.hoverDecorationCurrent,
          )}
        >
          {label}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <div
      {...stylex.props(
        sx.selectText,
        sx.whitespacePreWrap,
        sx.breakWords,
        sx.leadingSnug,
        sx.textFg,
        typography.body,
      )}
    >
      {parts}
    </div>
  );
}

function ReactionPills({ reactions }: { reactions?: MessageReaction[] }) {
  if (!reactions?.length) return null;
  return (
    <div {...stylex.props(sx.mt1, sx.flex, sx.flexWrap, sx.gap1)}>
      {reactions.map((r) => (
        <span
          key={r.name}
          title={`:${r.name}:`}
          {...stylex.props(
            sx.inlineFlex,
            sx.itemsCenter,
            sx.gap1,
            sx.roundedFull,
            sx.border,
            sx.borderLine,
            sx.bgPanel,
            sx.px15,
            sx.py05,
            sx.leadingNone,
            sx.textDim,
            typography.meta,
          )}
        >
          {r.url ? (
            <img
              src={r.url}
              alt={r.name}
              {...stylex.props(sx.h14px, sx.w14px)}
            />
          ) : (
            <span {...stylex.props(typography.label)}>
              {r.emoji || `:${r.name}:`}
            </span>
          )}
          <span {...stylex.props(sx.fontMedium)}>{r.count}</span>
        </span>
      ))}
    </div>
  );
}

function MessageRow({
  m,
  channelId,
  depth = 0,
}: {
  m: ChannelMessage;
  channelId: string;
  depth?: number;
}) {
  const [replies, setReplies] = useState<ChannelMessage[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loadingReplies, setLoadingReplies] = useState(false);

  async function toggleThread() {
    if (expanded) return setExpanded(false);
    setExpanded(true);
    if (replies !== null || loadingReplies) return;
    setLoadingReplies(true);
    await (async () => {
      const res = await fetch(
        `${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages?thread_ts=${encodeURIComponent(m.ts)}&limit=50`,
      );
      const body = await res.json();
      if (res.ok) setReplies(body.messages || []);
    })()
      .catch(async () => {})
      .finally(async () => {
        setLoadingReplies(false);
      });
  }

  const timeOf = (ts: string) => {
    const d = new Date(Number(ts) * 1000);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" }) +
          " " +
          d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div
      className={utilityClassName(
        `mb-3 flex gap-2.5 ${depth ? "mt-2 mb-0" : ""}`,
      )}
    >
      {m.avatarUrl ? (
        <img
          src={m.avatarUrl}
          alt=""
          {...stylex.props(sx.mt05, sx.h7, sx.w7, sx.flexShrink0, sx.roundedMd)}
        />
      ) : (
        <span
          {...stylex.props(
            sx.mt05,
            sx.flex,
            sx.h7,
            sx.w7,
            sx.flexShrink0,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.roundedMd,
            sx.bgActive,
            sx.textXs,
            sx.fontSemibold,
            sx.textDim,
          )}
        >
          {m.userName.charAt(0).toUpperCase()}
        </span>
      )}
      <div {...stylex.props(sx.minW0, sx.flex1)}>
        <div {...stylex.props(sx.flex, sx.itemsBaseline, sx.gap2)}>
          <span
            {...stylex.props(
              sx.selectText,
              sx.fontSemibold,
              sx.textFg,
              typography.itemTitle,
            )}
          >
            {m.userName}
          </span>
          <span {...stylex.props(sx.textFaint, typography.meta)}>
            {timeOf(m.ts)}
          </span>
        </div>
        <MessageText text={m.text} />
        <ReactionPills reactions={m.reactions} />
        {depth === 0 && (m.replyCount || 0) > 0 && (
          <button
            {...stylex.props(
              sx.mt1,
              sx.fontMedium,
              sx.textLink,
              sx.hoverUnderline,
              typography.meta,
            )}
            onClick={toggleThread}
          >
            {expanded
              ? "Hide thread"
              : `${m.replyCount} repl${m.replyCount === 1 ? "y" : "ies"}`}
          </button>
        )}
        {expanded && (
          <div {...stylex.props(sx.mt1, sx.borderL2, sx.borderLine, sx.pl3)}>
            {loadingReplies ? (
              <div {...stylex.props(sx.py1, sx.textXs, sx.textFaint)}>
                Loading thread…
              </div>
            ) : (
              (replies || []).map((r) => (
                <MessageRow key={r.ts} m={r} channelId={channelId} depth={1} />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Conversation pane for slack-channel feed workspaces (the Plain-thread
 * sibling): centred timeline, newest page first with "Load earlier"
 * pagination, 20s poll, inline expandable threads, linkified slack markup,
 * and a session-composer-styled box that posts AS THE SIGNED-IN USER via
 * their Slack grant (routes/slack-channels.ts).
 */
export function SlackChannelPane({
  channelId,
  className,
}: {
  channelId: string;
  className?: string;
}) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [asUser, setAsUser] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const aliveRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);
  const lastMarkedRef = useRef("");

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Depends on channelId: the poll effect refires when the channel changes.
  const loadNewest = useCallback(async () => {
    await (async () => {
      const res = await fetch(
        `${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages`,
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      if (!aliveRef.current) return;
      setAsUser(!!body.asUser);
      setHasMore((prev) => prev || !!body.hasMore);
      setMessages((prev) => {
        const incoming: ChannelMessage[] = body.messages || [];
        if (!prev.length) return incoming;
        const oldestIncoming = incoming[0]?.ts;
        const olders = prev.filter(
          (m) => oldestIncoming && m.ts < oldestIncoming,
        );
        return [...olders, ...incoming];
      });
      setError(null);
      // Viewing marks the channel read (as the signed-in user) so the
      // sidebar unread dot clears — same behavior as Slack itself.
      const newest = (body.messages || []).at(-1)?.ts;
      if (body.asUser && newest && newest !== lastMarkedRef.current) {
        lastMarkedRef.current = newest;
        void fetch(
          `${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/read`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ts: newest }),
          },
        ).catch(() => {});
      }
    })()
      .catch(async (error) => {
        if (aliveRef.current)
          setError(errorMessage(error, "Failed to load channel"));
      })
      .finally(async () => {
        if (aliveRef.current) setLoading(false);
      });
  }, [channelId]);

  useEffect(() => {
    setMessages([]);
    setLoading(true);
    void loadNewest();
    const t = setInterval(loadNewest, 20_000);
    return () => clearInterval(t);
  }, [loadNewest]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function loadOlder() {
    if (!messages.length || loadingOlder) return;
    setLoadingOlder(true);
    await (async () => {
      const res = await fetch(
        `${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages?before=${encodeURIComponent(messages[0].ts)}`,
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      const el = scrollRef.current;
      const prevHeight = el?.scrollHeight || 0;
      stickBottomRef.current = false;
      setMessages((prev) => [...(body.messages || []), ...prev]);
      setHasMore(!!body.hasMore);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Failed to load older messages"));
      })
      .finally(async () => {
        setLoadingOlder(false);
      });
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    await (async () => {
      const res = await fetch(
        `${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setDraft("");
      stickBottomRef.current = true;
      void loadNewest();
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Failed to send message"));
      })
      .finally(async () => {
        setSending(false);
      });
  }

  return (
    <div
      className={utilityClassName(
        `flex h-full min-h-0 flex-col ${className || ""}`,
      )}
    >
      <div
        ref={scrollRef}
        {...stylex.props(sx.minH0, sx.flex1, sx.overflowYAuto)}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div
          {...stylex.props(sx.mxAuto, sx.wFull, sx.maxW760px, sx.px5, sx.py4)}
        >
          {hasMore && (
            <div {...stylex.props(sx.mb3, sx.flex, sx.justifyCenter)}>
              <Button size="sm" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </Button>
            </div>
          )}
          {loading ? (
            <div
              {...stylex.props(sx.py8, sx.textCenter, sx.textSm, sx.textFaint)}
            >
              Loading channel…
            </div>
          ) : messages.length === 0 ? (
            <div
              {...stylex.props(sx.py8, sx.textCenter, sx.textSm, sx.textFaint)}
            >
              No recent messages.
            </div>
          ) : (
            messages.map((m) => (
              <MessageRow key={m.ts} m={m} channelId={channelId} />
            ))
          )}
        </div>
      </div>
      {error && (
        <div
          {...stylex.props(
            sx.mxAuto,
            sx.wFull,
            sx.maxW760px,
            sx.px5,
            sx.py2,
            sx.textXs,
            sx.textRed,
          )}
        >
          {error}
        </div>
      )}
      {/* Same visual family as the sessions Composer (lib/composer-classes) —
			    rounded card, borderless textarea, circular accent send — sized down
			    for a chat channel. */}
      <div
        {...stylex.props(
          sx.mxAuto,
          sx.wFull,
          sx.maxWCalcVarSessionCol40px,
          sx.shrink0,
          sx.px5,
          sx.pt1,
          sx.pb4,
        )}
      >
        {/* `composer` stays as a hook: base.css and legacy.css key phone
				    keyboard/shadow behaviour off the class name. */}
        <div
          className={cn(
            "composer",
            composerBox,
            composerBoxExpanded,
            !asUser && utilityClassName("opacity-60"),
          )}
        >
          <textarea
            // `composer-textarea` stays as a class NAME hook (the sidebar
            // swipe guard and SessionViewer's global keys look for it).
            className={cn(
              "composer-textarea",
              composerTextarea,
              composerTextareaPadding,
              utilityClassName("text-fg placeholder:text-faint"),
            )}
            style={{ minHeight: 48 }}
            placeholder={
              asUser
                ? "Message the channel as yourself…"
                : "Connect Slack in Settings → Account to post as yourself"
            }
            value={draft}
            disabled={!asUser || sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            {...noAutofill}
          />
          <div className={composerToolbar}>
            <div {...stylex.props(sx.shrink0, sx.grow, sx.basis0)} />
            <button
              className={cn(composerSend, composerSendDefault)}
              onClick={send}
              disabled={!asUser || !draft.trim() || sending}
              aria-label="Send message"
            >
              <IconArrowUp size={24} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
