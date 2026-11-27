import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { ListRow } from "../ui/list-row";
import { postMessage } from "../lib/api/slack-channels";
import { ChannelComposer } from "./channels/ChannelComposer";
import { errorMessage } from "../lib/error-message";
import { SlackText as MessageText } from "./channels/SlackText";

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

function ReactionPills({ reactions }: { reactions?: MessageReaction[] }) {
  if (!reactions?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((r) => (
        <span
          key={r.name}
          title={`:${r.name}:`}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-panel px-1.5 py-0.5 text-meta leading-none text-dim"
        >
          {r.url ? (
            <img src={r.url} alt={r.name} className="h-[14px] w-[14px]" />
          ) : (
            <span className="text-label">{r.emoji || `:${r.name}:`}</span>
          )}
          <span className="font-medium">{r.count}</span>
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
    <div className={`mb-3 flex gap-2.5 ${depth ? "mt-2 mb-0" : ""}`}>
      {m.avatarUrl ? (
        <img
          src={m.avatarUrl}
          alt=""
          className="mt-0.5 h-7 w-7 flex-shrink-0 rounded-md"
        />
      ) : (
        <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-active text-xs font-semibold text-dim">
          {m.userName.charAt(0).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="select-text text-item-title font-semibold text-fg">
            {m.userName}
          </span>
          <span className="text-meta text-faint">{timeOf(m.ts)}</span>
        </div>
        <MessageText text={m.text} />
        <ReactionPills reactions={m.reactions} />
        {depth === 0 && (m.replyCount || 0) > 0 && (
          <ListRow
            className="mt-1 min-h-0 w-auto p-0 text-meta font-medium text-link hover:bg-transparent hover:underline"
            onClick={toggleThread}
          >
            {expanded
              ? "Hide thread"
              : `${m.replyCount} repl${m.replyCount === 1 ? "y" : "ies"}`}
          </ListRow>
        )}
        {expanded && (
          <div className="mt-1 border-l-2 border-line pl-3">
            {loadingReplies ? (
              <div className="py-1 text-xs text-faint">Loading thread…</div>
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

  async function send(text: string): Promise<boolean> {
    setError(null);
    return postMessage(channelId, text)
      .then(() => {
        stickBottomRef.current = true;
        void loadNewest();
        return true;
      })
      .catch((error) => {
        setError(errorMessage(error, "Failed to send message"));
        return false;
      });
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${className || ""}`}>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto w-full max-w-[760px] px-5 py-4">
          {hasMore && (
            <div className="mb-3 flex justify-center">
              <Button size="sm" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </Button>
            </div>
          )}
          {loading ? (
            <div className="py-8 text-center text-sm text-faint">
              Loading channel…
            </div>
          ) : messages.length === 0 ? (
            <div className="py-8 text-center text-sm text-faint">
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
        <div className="mx-auto w-full max-w-[760px] px-5 py-2 text-xs text-red">
          {error}
        </div>
      )}
      <div className="mx-auto w-full max-w-[calc(var(--session-col)+40px)] shrink-0 px-5 pt-1 pb-4">
        <ChannelComposer
          placeholder="Message the channel as yourself"
          disabled={!asUser}
          disabledHint="Connect Slack in Settings, Account to post as yourself"
          onSend={send}
        />
      </div>
    </div>
  );
}
