import { useState } from "react";
import type { Conversation } from "../../lib/api/slack-channels";
import { conversationSections } from "../../lib/slack-conversations";
import { sidebarToolRowClass } from "../sidebar/SidebarToolsNav";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { InlineAlert, ListSkeleton } from "../../ui/state";
import { IconChevronDown, IconHash, IconLock } from "../icons";
import { UserAvatar } from "../UserAvatar";

/** A conversation's leading mark: `#`, a lock, or the person's photo. */
export function ConversationGlyph({
  conversation,
  size = 22,
}: {
  conversation: Pick<Conversation, "kind" | "name" | "avatarUrl">;
  size?: number;
}) {
  if (conversation.kind === "dm")
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
      >
        <UserAvatar
          name={conversation.name}
          image={conversation.avatarUrl}
          size={size - 2}
          className="rounded-sm"
        />
      </span>
    );
  if (conversation.kind === "group")
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-sm bg-hover text-meta font-semibold text-dim tabular-nums"
        style={{ width: size - 2, height: size - 2, margin: 1 }}
        aria-hidden
      >
        {conversation.name.split(",").length}
      </span>
    );
  const Glyph = conversation.kind === "private" ? IconLock : IconHash;
  return <Glyph size={size} className="shrink-0 text-faint" />;
}

function Section({
  title,
  conversations,
  activeId,
  onOpen,
  touch,
}: {
  title: string;
  conversations: Conversation[];
  activeId?: string;
  onOpen: (id: string) => void;
  touch: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (!conversations.length) return null;
  return (
    <div className="mt-3 first:mt-1">
      <ListRow
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "items-center gap-1 py-0 px-[calc(var(--sidebar-icon-left,16px)-var(--sidebar-nav-x,10px))] text-body text-dim hover:bg-transparent hover:text-fg",
          touch ? "min-h-11" : "h-[var(--sidebar-cap-h,28px)] min-h-0",
        )}
      >
        {title}
        <IconChevronDown
          size={16}
          className={cn(
            "text-faint transition-transform",
            !open && "-rotate-90",
          )}
        />
      </ListRow>
      {open && (
        <div className="flex flex-col gap-0.5">
          {conversations.map((conversation) => {
            const active = conversation.id === activeId;
            const unread = !!conversation.unread;
            return (
              <ListRow
                key={conversation.id}
                className={cn(
                  sidebarToolRowClass(active),
                  active ? "hover:bg-selected" : "hover:bg-transparent",
                  unread && !active && "font-semibold text-fg",
                )}
                aria-current={active ? "page" : undefined}
                onClick={() => onOpen(conversation.id)}
              >
                <ConversationGlyph conversation={conversation} />
                <span className="min-w-0 flex-1 truncate">
                  {conversation.name}
                </span>
                {!!conversation.unreadCount && (
                  <span
                    className="ml-auto rounded-full bg-accent px-1.5 text-meta leading-[18px] font-semibold text-on-accent tabular-nums"
                    aria-label={`${conversation.unreadCount} unread`}
                  >
                    {conversation.unreadCount}
                  </span>
                )}
              </ListRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A person's Slack sidebar: channels, then direct and group messages, with
 * unread ones in bold and a count on a direct message, as Slack shows them.
 */
export function ConversationList({
  conversations,
  activeId,
  loading,
  error,
  onOpen,
  touch = false,
}: {
  conversations: readonly Conversation[];
  activeId?: string;
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  /** Phone rows: 44px targets. */
  touch?: boolean;
}) {
  if (loading)
    return <ListSkeleton rows={8} variant="bare" className="px-2 pt-2" />;
  if (error && !conversations.length)
    return (
      <InlineAlert appearance="plain" className="mx-3 my-4">
        {error}
      </InlineAlert>
    );
  const { channels, direct } = conversationSections(conversations);
  return (
    <div className="pb-4">
      <Section
        title="Channels"
        conversations={channels}
        activeId={activeId}
        onOpen={onOpen}
        touch={touch}
      />
      <Section
        title="Direct messages"
        conversations={direct}
        activeId={activeId}
        onOpen={onOpen}
        touch={touch}
      />
    </div>
  );
}
