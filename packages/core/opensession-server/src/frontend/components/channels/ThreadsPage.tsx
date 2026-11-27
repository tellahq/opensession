import { useEffect, useEffectEvent, useState } from "react";
import type { Route } from "../../lib/app-route";
import {
  fetchThreads,
  postMessage,
  setReaction,
  type ChannelMessage,
  type ThreadSummary,
} from "../../lib/api/slack-channels";
import { peopleLine, toggledReactions } from "../../lib/channel-messages";
import { errorMessage } from "../../lib/error-message";
import {
  conversationLabel,
  useSlackConversations,
} from "../../lib/slack-conversations";
import { ListRow } from "../../ui/list-row";
import { PageLayout } from "../../ui/page";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconMessage } from "../icons";
import { ChannelComposer } from "./ChannelComposer";
import { ChannelMessageRow } from "./ChannelMessageRow";
import { ConversationGlyph } from "./ConversationList";

type Navigate = (route: Route, opts?: { replace?: boolean }) => void;

const POLL_MS = 60_000;

// A row's hover wash takes the card's corner less the card's 4px of air, so
// the two stay concentric.
const ROW_IN_CARD = "rounded-lg";

function ThreadCard({
  thread,
  label,
  conversation,
  onOpen,
  onReact,
  onReplied,
}: {
  thread: ThreadSummary;
  label: string;
  conversation: Parameters<typeof ConversationGlyph>[0]["conversation"];
  onOpen: () => void;
  onReact: (message: ChannelMessage, name: string, emoji?: string) => void;
  onReplied: () => void;
}) {
  const hidden = thread.replyCount - thread.latest.length;
  const people = peopleLine([
    thread.parent.userName,
    ...(thread.parent.replyUsers ?? []).map((user) => user.name),
    ...thread.latest.map((reply) => reply.userName),
  ]);
  const direct = conversation.kind === "dm" || conversation.kind === "group";
  return (
    <section aria-label={`Thread in ${label}`} className="flex flex-col gap-2">
      {/* The conversation it is in, on the message text's left edge. */}
      <ListRow
        onClick={onOpen}
        className="min-h-0 w-auto items-center gap-2 self-start px-1.5 py-1 hover:bg-hover"
      >
        <ConversationGlyph conversation={conversation} size={20} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-item-title font-semibold text-fg">
            {label}
          </span>
          {people && (
            <span className="truncate text-meta text-faint">{people}</span>
          )}
        </span>
      </ListRow>
      <div className="flex flex-col rounded-xl bg-panel p-1">
        <ChannelMessageRow
          channelId={thread.channelId}
          message={thread.parent}
          head
          className={ROW_IN_CARD}
          onReact={(name, emoji) => onReact(thread.parent, name, emoji)}
        />
        {hidden > 0 && (
          <ListRow
            onClick={onOpen}
            className="my-0.5 min-h-0 w-auto items-center self-start py-1 pr-2 pl-16 text-meta font-semibold text-link hover:underline"
          >
            Show {hidden} more {hidden === 1 ? "reply" : "replies"}
          </ListRow>
        )}
        {thread.latest.map((reply) => (
          <ChannelMessageRow
            key={reply.ts}
            channelId={thread.channelId}
            message={reply}
            head
            className={ROW_IN_CARD}
            onReact={(name, emoji) => onReact(reply, name, emoji)}
          />
        ))}
        <div className="px-3 pt-1.5 pb-2">
          <ChannelComposer
            compact
            placeholder="Reply"
            disabled={false}
            draftOf={{ channelId: thread.channelId, thread: thread.parent.ts }}
            broadcastLabel={direct ? undefined : `Also send to ${label}`}
            onSend={(text, broadcast) =>
              postMessage(thread.channelId, text, {
                ts: thread.parent.ts,
                broadcast,
              })
                .then(() => {
                  onReplied();
                  return true;
                })
                .catch((e) => {
                  toast(errorMessage(e, "Couldn't send the reply"), {
                    variant: "error",
                  });
                  return false;
                })
            }
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Threads: every thread you are in, latest activity first, each with its
 * first message, its newest replies and a box to answer in, as Slack's own
 * Threads view has them. The conversation's name opens the thread beside
 * its channel.
 */
export function ThreadsPage({ navigate }: { navigate: Navigate }) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { payload } = useSlackConversations();
  const conversations = payload?.conversations;

  function load(fresh = false) {
    return fetchThreads(fresh)
      .then((body) => {
        setThreads(body.threads);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e, "Couldn't load your threads")));
  }

  const poll = useEffectEvent(() => void load());
  useEffect(() => {
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  function updateMessage(
    channelId: string,
    ts: string,
    next: (message: ChannelMessage) => ChannelMessage,
  ) {
    setThreads(
      (current) =>
        current?.map((thread) =>
          thread.channelId !== channelId
            ? thread
            : {
                ...thread,
                parent:
                  thread.parent.ts === ts ? next(thread.parent) : thread.parent,
                latest: thread.latest.map((m) => (m.ts === ts ? next(m) : m)),
              },
        ) ?? null,
    );
  }

  function react(
    channelId: string,
    message: ChannelMessage,
    name: string,
    emoji?: string,
  ) {
    const before = message.reactions ?? [];
    const remove = !!before.find((r) => r.name === name)?.mine;
    updateMessage(channelId, message.ts, (m) => ({
      ...m,
      reactions: toggledReactions(m, name, emoji),
    }));
    void setReaction(channelId, message.ts, name, remove).catch((e) => {
      updateMessage(channelId, message.ts, (m) => ({
        ...m,
        reactions: before,
      }));
      toast(errorMessage(e, "Couldn't react"), { variant: "error" });
    });
  }

  return (
    <PageLayout title="Threads">
      {threads === null && !error ? (
        <LoadingState className="py-16" />
      ) : error && !threads?.length ? (
        <InlineAlert appearance="plain" onRetry={() => void load(true)}>
          {error}
        </InlineAlert>
      ) : !threads?.length ? (
        <EmptyState
          className="py-16"
          icon={<IconMessage size={22} />}
          title="No threads yet"
        >
          Threads you reply in show here.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-8 pb-10">
          {threads.map((thread) => {
            const { label, conversation } = conversationLabel(
              conversations,
              thread.channelId,
              { name: thread.channelName, isDirect: thread.isDirect },
            );
            return (
              <ThreadCard
                key={`${thread.channelId}:${thread.parent.ts}`}
                thread={thread}
                label={label}
                conversation={conversation}
                onOpen={() =>
                  navigate({
                    view: "channels",
                    id: thread.channelId,
                    thread: thread.parent.ts,
                  })
                }
                onReact={(message, name, emoji) =>
                  react(thread.channelId, message, name, emoji)
                }
                onReplied={() => void load(true)}
              />
            );
          })}
        </div>
      )}
    </PageLayout>
  );
}
