import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useChannelMessages } from "../../hooks/useChannelMessages";
import { useNavigation } from "../../hooks/useNavigation";
import type { Route } from "../../lib/app-route";
import {
  fetchConversationInfo,
  type Conversation,
  type ConversationInfo,
} from "../../lib/api/slack-channels";
import { layoutMessages } from "../../lib/channel-messages";
import { docTitle } from "../../lib/brand";
import {
  rememberChannel,
  useSlackConversations,
} from "../../lib/slack-conversations";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import { Tooltip } from "../../ui/tooltip";
import { IconHash, IconX } from "../icons";
import { ChannelCallButton } from "./ChannelCallButton";
import { ChannelComposer } from "./ChannelComposer";
import { ChannelMessageRow } from "./ChannelMessageRow";
import { ConversationGlyph, ConversationList } from "./ConversationList";

type Navigate = (route: Route, opts?: { replace?: boolean }) => void;

/** `#name` for a channel, the name alone for a person or a group. */
function displayName(info: { name: string; kind: Conversation["kind"] }) {
  return info.kind === "channel" || info.kind === "private"
    ? `#${info.name}`
    : info.name;
}

const NO_GRANT_HINT = "Connect Slack in Settings, Account to post";

function MessageList({
  state,
  channelId,
  openThread,
  onOpenThread,
  intro,
}: {
  state: ReturnType<typeof useChannelMessages>;
  channelId: string;
  openThread?: string;
  onOpenThread?: (ts: string) => void;
  /** Above a thread's replies: its first message. */
  intro?: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const items = layoutMessages(state.messages);

  // Follow new messages while you are at the bottom, and stay put when
  // older ones load above.
  const previousHeight = useRef(0);
  const previousFirst = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = state.messages[0]?.ts;
    if (
      previousFirst.current &&
      first !== previousFirst.current &&
      !stick.current
    )
      el.scrollTop += el.scrollHeight - previousHeight.current;
    else if (stick.current) el.scrollTop = el.scrollHeight;
    previousHeight.current = el.scrollHeight;
    previousFirst.current = first;
  }, [state.messages]);
  useEffect(() => {
    stick.current = true;
    previousFirst.current = undefined;
  }, [channelId]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="flex min-h-full flex-col justify-end px-2 pt-4 pb-2">
        {state.hasMore && onOpenThread && (
          <div className="mb-2 flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void state.loadOlder()}
              disabled={state.loadingOlder}
            >
              {state.loadingOlder ? "Loading" : "Load earlier messages"}
            </Button>
          </div>
        )}
        {intro}
        {state.loading && !state.messages.length ? (
          <LoadingState className="py-10" />
        ) : state.error && !state.messages.length ? (
          <InlineAlert
            appearance="plain"
            onRetry={state.reload}
            className="mx-3 my-6"
          >
            {state.error}
          </InlineAlert>
        ) : !state.messages.length && !intro ? (
          <EmptyState className="py-10" title="No messages yet" />
        ) : (
          items.map((item) =>
            item.kind === "day" ? (
              <div
                key={item.key}
                className="sticky top-0 z-[5] my-2 flex justify-center"
              >
                <span className="rounded-full bg-panel px-3 py-1 text-meta font-medium text-dim">
                  {item.label}
                </span>
              </div>
            ) : (
              <ChannelMessageRow
                key={item.key}
                message={item.message}
                head={item.head}
                threadOpen={openThread === item.message.ts}
                onReact={
                  state.asUser
                    ? (name, emoji) => state.react(item.message, name, emoji)
                    : undefined
                }
                onOpenThread={
                  onOpenThread ? () => onOpenThread(item.message.ts) : undefined
                }
              />
            ),
          )
        )}
      </div>
    </div>
  );
}

function ThreadPanel({
  channelId,
  thread,
  channelLabel,
  parent,
  onClose,
}: {
  channelId: string;
  thread: string;
  channelLabel: string;
  parent: ReturnType<typeof useChannelMessages>["messages"][number] | undefined;
  onClose: () => void;
}) {
  const replies = useChannelMessages(channelId, thread);
  const phone = useIsPhone();
  return (
    <aside
      aria-label="Thread"
      className={cn(
        "flex min-h-0 flex-col",
        phone
          ? "absolute inset-0 z-20 bg-surface"
          : "w-[min(420px,42%)] shrink-0 border-l border-divider",
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-divider-soft px-4">
        <div className="min-w-0 flex-1">
          <span className="text-item-title font-semibold text-fg">Thread</span>
          <span className="ml-2 truncate text-meta text-faint">
            {channelLabel}
          </span>
        </div>
        {!phone && (
          <Tooltip label="Close thread">
            <Button
              variant="ghost"
              size="sm"
              icon={<IconX size={18} />}
              aria-label="Close thread"
              onClick={onClose}
            />
          </Tooltip>
        )}
      </header>
      <MessageList
        state={replies}
        channelId={`${channelId}:${thread}`}
        intro={
          parent && (
            <div className="mb-1 border-b border-divider-soft pb-2">
              <ChannelMessageRow message={parent} head />
              {!!parent.replyCount && (
                <div className="px-3 pt-2 text-meta text-faint">
                  {parent.replyCount}{" "}
                  {parent.replyCount === 1 ? "reply" : "replies"}
                </div>
              )}
            </div>
          )
        }
      />
      <div className="shrink-0 px-3 pt-1 pb-[max(12px,env(safe-area-inset-bottom))]">
        <ChannelComposer
          key={thread}
          placeholder="Reply"
          disabled={!replies.asUser}
          disabledHint={NO_GRANT_HINT}
          broadcastLabel={`Also send to ${channelLabel}`}
          onSend={replies.send}
          autoFocus={!phone}
        />
      </div>
    </aside>
  );
}

/**
 * The Channels place's page: a Slack conversation as its own Slack shows it,
 * read and written as the signed-in person. The conversation list is the
 * sidebar beside it (ChannelsSidebar); on a phone, where the new layout's
 * sidebar does not run, the page lists the conversations itself until one
 * is open. A thread opens in a column on the right, or over the channel on
 * a phone. Each step is its own history entry, so the phone's top bar back
 * button walks thread, channel, list.
 */
export function ChannelsPage({
  route,
  navigate,
}: {
  route: Extract<Route, { view: "channels" }>;
  navigate: Navigate;
}) {
  const phone = useIsPhone();
  const { payload, error } = useSlackConversations(!route.id || phone);
  const navigation = useNavigation();

  // Desktop with nothing chosen: open the first channel, as Slack does.
  const first = payload?.conversations[0]?.id;
  useEffect(() => {
    if (!route.id && !phone && first)
      navigate({ view: "channels", id: first }, { replace: true });
  }, [route.id, phone, first, navigate]);

  if (payload && !payload.connected)
    return (
      <EmptyState
        className="m-auto max-w-sm"
        icon={<IconHash size={22} />}
        title="Connect Slack"
        action={
          <Button
            variant="primary"
            onClick={() => navigation.openSettings("myAccounts")}
          >
            Open account settings
          </Button>
        }
      >
        Your channels, direct messages and threads show here once your Slack
        account is connected.
      </EmptyState>
    );

  if (!route.id) {
    if (phone)
      return (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-[var(--header-h,0px)] pb-6">
          <ConversationList
            conversations={payload?.conversations ?? []}
            loading={!payload && !error}
            error={error}
            onOpen={(id) => navigate({ view: "channels", id })}
            touch
          />
        </div>
      );
    return error ? (
      <InlineAlert appearance="plain" className="m-auto">
        {error}
      </InlineAlert>
    ) : (
      <LoadingState className="m-auto" />
    );
  }

  return (
    <ConversationView
      key={route.id}
      channelId={route.id}
      thread={route.thread}
      listed={payload?.conversations.find((c) => c.id === route.id)}
      navigate={navigate}
    />
  );
}

function ConversationView({
  channelId,
  thread,
  listed,
  navigate,
}: {
  channelId: string;
  thread?: string;
  listed?: Conversation;
  navigate: Navigate;
}) {
  const phone = useIsPhone();
  const [info, setInfo] = useState<ConversationInfo | null>(null);
  const main = useChannelMessages(channelId);

  useEffect(() => {
    rememberChannel(channelId);
    let alive = true;
    void fetchConversationInfo(channelId)
      .then((next) => alive && setInfo(next))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [channelId]);

  const head = info ?? listed;
  const label = head ? displayName(head) : "";
  useEffect(() => {
    if (label) document.title = docTitle(label);
  }, [label]);

  const parent = thread
    ? main.messages.find((m) => m.ts === thread)
    : undefined;
  const openThread = (ts?: string) =>
    navigate(
      ts
        ? { view: "channels", id: channelId, thread: ts }
        : { view: "channels", id: channelId },
      { replace: !!thread && !!ts },
    );

  return (
    <div className="relative flex min-h-0 flex-1">
      <section
        aria-label={label || "Channel"}
        className="flex min-w-0 flex-1 flex-col"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-divider-soft px-4">
          {head && <ConversationGlyph conversation={head} size={20} />}
          <h1 className="min-w-0 truncate text-item-title font-semibold text-fg">
            {head?.name ?? ""}
          </h1>
          {info?.topic && (
            <span className="min-w-0 flex-1 truncate text-meta text-faint phone:hidden">
              {info.topic}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {info?.memberCount !== undefined &&
              (info.kind === "channel" || info.kind === "private") && (
                <span className="px-1 text-meta text-faint tabular-nums">
                  {info.memberCount}{" "}
                  {info.memberCount === 1 ? "member" : "members"}
                </span>
              )}
            {label && <ChannelCallButton channelId={channelId} label={label} />}
          </div>
        </header>
        <MessageList
          state={main}
          channelId={channelId}
          openThread={thread}
          onOpenThread={(ts) => openThread(ts)}
        />
        <div className="shrink-0 px-3 pt-1 pb-[max(12px,env(safe-area-inset-bottom))]">
          <ChannelComposer
            key={channelId}
            placeholder={label ? `Message ${label}` : "Message"}
            disabled={!main.asUser}
            disabledHint={NO_GRANT_HINT}
            onSend={(text) => main.send(text)}
            autoFocus={!phone && !thread}
          />
        </div>
      </section>
      {thread && (
        <ThreadPanel
          key={thread}
          channelId={channelId}
          thread={thread}
          channelLabel={label}
          parent={parent}
          onClose={() => openThread()}
        />
      )}
    </div>
  );
}
