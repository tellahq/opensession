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
import { toggledReactions } from "../lib/channel-messages";
import { errorMessage } from "../lib/error-message";
import { markConversationSeen } from "../lib/slack-conversations";
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
  // The open conversation's fetch, so a send can refresh it in place.
  const refresh = useRef<(() => Promise<void>) | null>(null);

  const markNewest = useEffectEvent((page: ChannelMessage[], user: boolean) => {
    if (thread || !user) return;
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
    lastMarked.current = "";
    const load = () =>
      fetchMessages(channelId, { thread })
        .then((page) => {
          if (!alive) return;
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
  };
}
