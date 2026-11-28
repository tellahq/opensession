import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  deleteMessage,
  editMessage,
  fetchMessages,
  markRead,
  postMessage,
  setReaction,
  uploadFile,
  type ChannelMessage,
} from "../lib/api/slack-channels";
import {
  firstUnread,
  toggledReactions,
  tsBefore,
} from "../lib/channel-messages";
import { errorMessage } from "../lib/error-message";
import {
  markConversationSeen,
  markConversationUnread,
} from "../lib/slack-conversations";
import { toast } from "../ui/toast";

const POLL_MS = 15_000;

export interface ChannelMessagesState {
  messages: ChannelMessage[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingOlder: boolean;
  /** Read with the person's own grant, so they can post and react. */
  asUser: boolean;
  loadOlder: () => Promise<void>;
  send: (text: string, broadcast?: boolean, files?: File[]) => Promise<boolean>;
  react: (message: ChannelMessage, name: string, emoji?: string) => void;
  /** The ts of the message open for editing. */
  editing: string | null;
  setEditing: (ts: string | null) => void;
  /** Save an edit of the person's own message. */
  edit: (message: ChannelMessage, text: string) => Promise<boolean>;
  /** Delete the person's own message. */
  remove: (message: ChannelMessage) => void;
  reload: () => void;
  /** Where Slack's "New" line goes: the first message from someone else
   *  that was unread when the conversation opened. */
  unreadFrom?: string;
  /** Leave `message` and everything after it unread, until you come back. */
  markUnread: (message: ChannelMessage) => void;
  /** Esc: read up to the newest message and drop the "New" line. */
  markAllRead: () => void;
}

/**
 * One Slack conversation, or one thread in it (`thread` is the parent's
 * ts): the newest page, polled while open, with older pages on request.
 * Opening a channel marks it read as the person, as Slack does.
 */
export function useChannelMessages(
  channelId: string,
  thread?: string,
): ChannelMessagesState {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [asUser, setAsUser] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const lastMarked = useRef("");
  // The read cursor as the conversation opened, for the "New" line.
  const [lastRead, setLastRead] = useState<string | null>(null);
  // Marked unread: stop reading new messages until the person comes back.
  const heldUnread = useRef(false);
  // The open conversation's fetch, so a send can refresh it in place.
  const refresh = useRef<(() => Promise<void>) | null>(null);

  const markNewest = useEffectEvent((page: ChannelMessage[], user: boolean) => {
    if (thread || !user || heldUnread.current) return;
    const newest = page.at(-1)?.ts;
    if (!newest || newest === lastMarked.current) return;
    lastMarked.current = newest;
    markConversationSeen(channelId);
    void markRead(channelId, newest).catch(() => {});
  });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setMessages([]);
    setLoading(true);
    setError(null);
    setHasMore(false);
    setEditing(null);
    setLastRead(null);
    lastMarked.current = "";
    heldUnread.current = false;
    let opening = !thread;
    const load = () =>
      fetchMessages(channelId, { thread, read: opening })
        .then((page) => {
          if (!alive) return;
          if (opening) setLastRead(page.lastRead ?? null);
          opening = false;
          setAsUser(page.asUser);
          setHasMore((previous) => previous || page.hasMore);
          setMessages((previous) => {
            if (!previous.length) return page.messages;
            // Keep older pages loaded above the newest one.
            const oldest = page.messages[0]?.ts;
            const older = oldest
              ? previous.filter((m) => Number(m.ts) < Number(oldest))
              : [];
            return [...older, ...page.messages];
          });
          setError(null);
          markNewest(page.messages, page.asUser);
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e, "Couldn't load messages"));
        })
        .finally(() => {
          if (!alive) return;
          setLoading(false);
          if (timer) clearTimeout(timer);
          timer = setTimeout(load, POLL_MS);
        });
    refresh.current = load;
    void load();
    return () => {
      alive = false;
      refresh.current = null;
      if (timer) clearTimeout(timer);
    };
  }, [channelId, thread, reloadKey]);

  function markUnread(message: ChannelMessage) {
    if (thread || !asUser) return;
    const cursor = tsBefore(message.ts);
    heldUnread.current = true;
    lastMarked.current = "";
    setLastRead(cursor);
    markConversationUnread(channelId);
    void markRead(channelId, cursor).catch(() => {
      toast("Couldn't mark it unread", { variant: "error" });
    });
  }

  function markAllRead() {
    heldUnread.current = false;
    setLastRead(null);
    const newest = messages.at(-1)?.ts;
    if (thread || !asUser || !newest) return;
    lastMarked.current = newest;
    markConversationSeen(channelId);
    void markRead(channelId, newest).catch(() => {});
  }

  async function loadOlder() {
    const oldest = messages[0]?.ts;
    if (!oldest || loadingOlder || thread) return;
    setLoadingOlder(true);
    await fetchMessages(channelId, { before: oldest })
      .then((page) => {
        setMessages((previous) => [...page.messages, ...previous]);
        setHasMore(page.hasMore);
      })
      .catch((e) => {
        toast(errorMessage(e, "Couldn't load older messages"), {
          variant: "error",
        });
      })
      .finally(() => setLoadingOlder(false));
  }

  async function send(
    text: string,
    broadcast = false,
    files: File[] = [],
  ): Promise<boolean> {
    try {
      const uploaded = [];
      for (const file of files)
        uploaded.push(await uploadFile(channelId, file));
      await postMessage(
        channelId,
        text,
        thread ? { ts: thread, broadcast } : undefined,
        uploaded,
      );
      void refresh.current?.();
      return true;
    } catch (e) {
      toast(errorMessage(e, "Couldn't send the message"), { variant: "error" });
      return false;
    }
  }

  function replace(ts: string, next: (m: ChannelMessage) => ChannelMessage) {
    setMessages((previous) => previous.map((m) => (m.ts === ts ? next(m) : m)));
  }

  function react(message: ChannelMessage, name: string, emoji?: string) {
    const before = message.reactions ?? [];
    const remove = !!before.find((r) => r.name === name)?.mine;
    replace(message.ts, (m) => ({
      ...m,
      reactions: toggledReactions(m, name, emoji),
    }));
    void setReaction(channelId, message.ts, name, remove).catch((e) => {
      replace(message.ts, (m) => ({ ...m, reactions: before }));
      toast(errorMessage(e, "Couldn't react"), { variant: "error" });
    });
  }

  async function edit(message: ChannelMessage, text: string) {
    if (text === message.source) {
      setEditing(null);
      return true;
    }
    try {
      const saved = await editMessage(channelId, message.ts, text);
      replace(message.ts, (m) => ({
        ...m,
        text: saved.text,
        source: saved.source,
        edited: true,
      }));
      setEditing(null);
      return true;
    } catch (e) {
      toast(errorMessage(e, "Couldn't save the edit"), { variant: "error" });
      return false;
    }
  }

  function remove(message: ChannelMessage) {
    const index = messages.findIndex((m) => m.ts === message.ts);
    setMessages((previous) => previous.filter((m) => m.ts !== message.ts));
    void deleteMessage(channelId, message.ts).catch((e) => {
      setMessages((previous) =>
        previous.some((m) => m.ts === message.ts)
          ? previous
          : previous.toSpliced(Math.max(index, 0), 0, message),
      );
      toast(errorMessage(e, "Couldn't delete the message"), {
        variant: "error",
      });
    });
  }

  return {
    messages,
    loading,
    error,
    hasMore,
    loadingOlder,
    asUser,
    loadOlder,
    send,
    react,
    editing,
    setEditing,
    edit,
    remove,
    reload: () => setReloadKey((key) => key + 1),
    unreadFrom: firstUnread(messages, lastRead),
    markUnread,
    markAllRead,
  };
}
