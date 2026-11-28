import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useChannelMessages } from "../../hooks/useChannelMessages";
import { useNavigation } from "../../hooks/useNavigation";
import type { Route } from "../../lib/app-route";
import {
  fetchConversationInfo,
  type ChannelMessage,
  type Conversation,
  type ConversationInfo,
} from "../../lib/api/slack-channels";
import { needsOlder, takeJump } from "../../lib/channel-jump";
import { lastEditable, layoutMessages } from "../../lib/channel-messages";
import { docTitle } from "../../lib/brand";
import {
  rememberChannel,
  useSlackConversations,
} from "../../lib/slack-conversations";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { useConfirm } from "../../ui/confirm";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import { toast } from "../../ui/toast";
import { Tooltip } from "../../ui/tooltip";
import { IconHash, IconPeople, IconX } from "../icons";
import { ChannelCallButton } from "./ChannelCallButton";
import { ChannelComposer, type ComposerHandle } from "./ChannelComposer";
import { ChannelMessageRow } from "./ChannelMessageRow";
import { ConversationGlyph, ConversationList } from "./ConversationList";
import { DraftsPage } from "./DraftsPage";
import { SearchPage } from "./SearchPage";
import { FileDropZone } from "./FileDropZone";
import { ThreadsPage } from "./ThreadsPage";

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
  conversationId,
  openThread,
  onOpenThread,
  intro,
}: {
  state: ReturnType<typeof useChannelMessages>;
  /** Keys the scroll position: a channel, or a thread in it. */
  channelId: string;
  /** The Slack conversation the messages belong to. */
  conversationId: string;
  openThread?: string;
  onOpenThread?: (ts: string) => void;
  /** Above a thread's replies: its first message. */
  intro?: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const items = layoutMessages(state.messages);
  const [confirm, confirmDialog] = useConfirm();

  // Opened from a search result: page back to the message if it is older
  // than what loaded, then bring it to the middle and mark it.
  const [jumpTo, setJumpTo] = useState(() => takeJump(channelId));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const pagesLeft = useRef(10);
  const stepJump = useEffectEvent(() => {
    if (!jumpTo || state.loading || state.loadingOlder) return;
    if (needsOlder(state.messages, jumpTo, state.hasMore, pagesLeft.current)) {
      pagesLeft.current -= 1;
      void state.loadOlder();
      return;
    }
    setJumpTo(undefined);
    const row = scrollRef.current?.querySelector(
      `[data-ts="${CSS.escape(jumpTo)}"]`,
    );
    if (!row) {
      toast("That message is too far back to show here");
      return;
    }
    stick.current = false;
    row.scrollIntoView({ block: "center" });
    setHighlighted(jumpTo);
  });
  useEffect(() => {
    stepJump();
  }, [jumpTo, state.messages, state.loading, state.loadingOlder]);
  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(null), 2500);
    return () => clearTimeout(timer);
  }, [highlighted]);
  const askDelete = (message: ChannelMessage) =>
    confirm({
      title: "Delete message?",
      description: "It is removed for everyone. This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () => state.remove(message),
    });

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
  // Images and files load after the messages lay out: keep the bottom in
  // view while you are there.
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      previousHeight.current = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div
        ref={contentRef}
        className="flex min-h-full flex-col justify-end pt-4 pb-2"
      >
        {state.hasMore && onOpenThread && (
          <div className="mb-2 flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void state.loadOlder()}
              disabled={state.loadingOlder}
            >
              {state.loadingOlder ? "Loading…" : "Load earlier messages"}
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
              // Slack's day divider: a rule across, the day in a pill on it.
              <div
                key={item.key}
                className="relative my-3 flex justify-center before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-divider"
              >
                <span className="relative rounded-full border border-line bg-surface px-3.5 py-0.5 text-meta font-semibold text-fg">
                  {item.label}
                </span>
              </div>
            ) : (
              <ChannelMessageRow
                key={item.key}
                channelId={conversationId}
                message={item.message}
                head={item.head}
                threadOpen={openThread === item.message.ts}
                highlight={highlighted === item.message.ts}
                onReact={
                  state.asUser
                    ? (name, emoji) => state.react(item.message, name, emoji)
                    : undefined
                }
                onOpenThread={
                  onOpenThread ? () => onOpenThread(item.message.ts) : undefined
                }
                {...ownMessageProps(state, item.message, askDelete)}
              />
            ),
          )
        )}
      </div>
      {confirmDialog}
    </div>
  );
}

/** Up in an empty composer: open the person's latest message to edit. */
function editLast(state: ReturnType<typeof useChannelMessages>) {
  if (!state.asUser) return;
  const message = lastEditable(state.messages);
  if (message) state.setEditing(message.ts);
}

/** Edit and Delete for the person's own message; nothing for anyone else's. */
function ownMessageProps(
  state: ReturnType<typeof useChannelMessages>,
  message: ChannelMessage,
  askDelete: (message: ChannelMessage) => void,
): Partial<React.ComponentProps<typeof ChannelMessageRow>> {
  if (!state.asUser || !message.mine || message.source === undefined) return {};
  return {
    editing: state.editing === message.ts,
    onEdit: () => state.setEditing(message.ts),
    onSaveEdit: (text) => state.edit(message, text),
    onCancelEdit: () => state.setEditing(null),
    onDelete: () => askDelete(message),
  };
}

function ThreadPanel({
  channelId,
  thread,
  channelLabel,
  parent,
  onReactParent,
  onClose,
}: {
  channelId: string;
  thread: string;
  channelLabel: string;
  parent: ChannelMessage | undefined;
  /** Reacting to the thread's first message updates the channel's copy. */
  onReactParent: (
    message: ChannelMessage,
    name: string,
    emoji?: string,
  ) => void;
  onClose: () => void;
}) {
  const replies = useChannelMessages(channelId, thread);
  const phone = useIsPhone();
  const composer = useRef<ComposerHandle>(null);
  return (
    <aside
      aria-label="Thread"
      className={cn(
        "flex min-h-0 flex-col",
        phone
          ? "absolute inset-0 z-float bg-surface"
          : "w-[min(420px,42%)] shrink-0 border-l border-divider",
      )}
    >
      <FileDropZone
        label="Upload to this thread"
        disabled={!replies.asUser}
        onFiles={(files) => composer.current?.addFiles(files)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-divider-soft px-5">
          <div className="min-w-0 flex-1">
            <span className="text-item-title font-bold text-fg">Thread</span>
            <span className="ml-2 truncate text-meta text-faint">
              {channelLabel}
            </span>
          </div>
          {!phone && (
            <Tooltip label="Close thread">
              <Button
                variant="ghost"
                size="sm"
                icon={<IconX size={20} />}
                aria-label="Close thread"
                onClick={onClose}
              />
            </Tooltip>
          )}
        </header>
        <MessageList
          state={replies}
          channelId={`${channelId}:${thread}`}
          conversationId={channelId}
          intro={
            parent && (
              <div className="mb-1">
                <ChannelMessageRow
                  channelId={channelId}
                  message={parent}
                  head
                  onReact={
                    replies.asUser
                      ? (name, emoji) => onReactParent(parent, name, emoji)
                      : undefined
                  }
                />
                {/* Slack's "15 replies" rule between the message and its
                  thread. */}
                {!!parent.replyCount && (
                  <div className="flex items-center gap-3 px-5 pt-3 pb-1 text-meta text-dim after:h-px after:flex-1 after:bg-divider">
                    {parent.replyCount}{" "}
                    {parent.replyCount === 1 ? "reply" : "replies"}
                  </div>
                )}
              </div>
            )
          }
        />
        <div className="shrink-0 px-5 pt-1 pb-[max(16px,env(safe-area-inset-bottom))] phone:px-3">
          <ChannelComposer
            key={thread}
            draftOf={{ channelId, thread }}
            placeholder="Reply"
            disabled={!replies.asUser}
            disabledHint={NO_GRANT_HINT}
            broadcastLabel={`Also send to ${channelLabel}`}
            onSend={replies.send}
            onEditLast={() => editLast(replies)}
            autoFocus={!phone}
            acceptFiles
            ref={composer}
          />
        </div>
      </FileDropZone>
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
    if (!route.id && !route.page && !phone && first)
      navigate({ view: "channels", id: first }, { replace: true });
  }, [route.id, route.page, phone, first, navigate]);

  useEffect(() => {
    if (route.page) rememberChannel(route.page);
  }, [route.page]);

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

  if (route.page === "threads") return <ThreadsPage navigate={navigate} />;
  if (route.page === "drafts") return <DraftsPage navigate={navigate} />;
  if (route.page === "search")
    return <SearchPage query={route.query} navigate={navigate} />;

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
  const composer = useRef<ComposerHandle>(null);

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
      <FileDropZone
        label={label ? `Upload to ${label}` : "Upload"}
        disabled={!main.asUser}
        onFiles={(files) => composer.current?.addFiles(files)}
        className="flex min-w-0 flex-1 flex-col"
      >
        <section
          aria-label={label || "Channel"}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-divider-soft px-5">
            {head && <ConversationGlyph conversation={head} size={22} />}
            <h1 className="min-w-0 truncate text-dialog-title font-bold text-fg">
              {head?.name ?? ""}
            </h1>
            {info?.topic && (
              <span className="ml-3 min-w-0 flex-1 truncate text-body text-dim phone:hidden">
                {info.topic}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {info?.memberCount !== undefined &&
                (info.kind === "channel" || info.kind === "private") && (
                  <span
                    className="flex items-center gap-1 px-1.5 text-body text-dim tabular-nums"
                    aria-label={`${info.memberCount} ${info.memberCount === 1 ? "member" : "members"}`}
                  >
                    <IconPeople size={20} />
                    {info.memberCount}
                  </span>
                )}
              {label && (
                <ChannelCallButton channelId={channelId} label={label} />
              )}
            </div>
          </header>
          <MessageList
            state={main}
            channelId={channelId}
            conversationId={channelId}
            openThread={thread}
            onOpenThread={(ts) => openThread(ts)}
          />
          <div className="shrink-0 px-5 pt-1 pb-[max(16px,env(safe-area-inset-bottom))] phone:px-3">
            <ChannelComposer
              key={channelId}
              draftOf={{ channelId }}
              placeholder={label ? `Message ${label}` : "Message"}
              disabled={!main.asUser}
              disabledHint={NO_GRANT_HINT}
              onSend={(text, _broadcast, files) =>
                main.send(text, false, files)
              }
              onEditLast={() => editLast(main)}
              acceptFiles
              ref={composer}
              autoFocus={!phone && !thread}
            />
          </div>
        </section>
      </FileDropZone>
      {thread && (
        <ThreadPanel
          key={thread}
          channelId={channelId}
          thread={thread}
          channelLabel={label}
          parent={parent}
          onReactParent={main.react}
          onClose={() => openThread()}
        />
      )}
    </div>
  );
}
