import type {
  ChannelMessage,
  MessageReaction,
} from "../../lib/api/slack-channels";
import { fileSrc } from "../../lib/api/slack-channels";
import {
  messageTime,
  QUICK_REACTIONS,
  replySummary,
} from "../../lib/channel-messages";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Menu } from "../../ui/menu";
import { ListRow } from "../../ui/list-row";
import { Tooltip } from "../../ui/tooltip";
import { IconFile, IconMessage, IconReactionAdd } from "../icons";
import { UserAvatar } from "../UserAvatar";
import { SlackText } from "./SlackText";

function Reactions({
  reactions,
  onToggle,
}: {
  reactions: MessageReaction[];
  onToggle?: (reaction: MessageReaction) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {reactions.map((r) => (
        <ListRow
          key={r.name}
          title={`:${r.name}:`}
          aria-pressed={!!r.mine}
          disabled={!onToggle}
          onClick={() => onToggle?.(r)}
          className={cn(
            "inline-flex h-6 min-h-0 w-auto items-center gap-1 rounded-full px-2 py-0 text-meta leading-none text-dim",
            r.mine ? "bg-accent-soft text-accent" : "bg-hover hover:bg-pressed",
          )}
        >
          {r.url ? (
            <img src={r.url} alt={r.name} className="size-3.5" />
          ) : (
            <span className="text-label">{r.emoji || `:${r.name}:`}</span>
          )}
          <span className="font-medium tabular-nums">{r.count}</span>
        </ListRow>
      ))}
    </div>
  );
}

function Files({ files }: { files: NonNullable<ChannelMessage["files"]> }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {files.map((file, index) =>
        file.thumb ? (
          <a
            key={index}
            href={file.permalink}
            target="_blank"
            rel="noreferrer"
            className="block overflow-hidden rounded-lg bg-hover"
          >
            <img
              src={fileSrc(file.thumb)}
              alt={file.name}
              loading="lazy"
              width={file.width}
              height={file.height}
              className="block h-auto max-h-[320px] w-auto max-w-[min(100%,420px)] object-contain"
            />
          </a>
        ) : (
          <a
            key={index}
            href={file.permalink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-2 rounded-lg bg-hover px-3 py-2 text-body text-fg hover:bg-pressed"
          >
            <IconFile size={18} className="shrink-0 text-dim" />
            <span className="truncate">{file.name}</span>
          </a>
        ),
      )}
    </div>
  );
}

/**
 * One Slack message. The first of a run shows its author's photo and name;
 * a follow-up shows only its time, on hover, where the photo would be.
 * Reacting and replying sit on a small bar at the top right on hover, or
 * once the message is tapped on a touch screen.
 */
export function ChannelMessageRow({
  message,
  head,
  onReact,
  onOpenThread,
  threadOpen = false,
}: {
  message: ChannelMessage;
  head: boolean;
  /** Absent without a Slack grant: reading only. */
  onReact?: (name: string, emoji?: string) => void;
  /** Absent inside a thread. */
  onOpenThread?: () => void;
  threadOpen?: boolean;
}) {
  const replies = message.replyCount ?? 0;
  return (
    // Focusable without being a tab stop, so a tap on a touch screen, which
    // has no hover, selects the message and shows its actions.
    <div
      tabIndex={-1}
      className={cn(
        "group relative flex gap-2.5 rounded-lg px-3 outline-none transition-colors hover:bg-hover focus-within:bg-hover",
        head ? "mt-2 pt-1.5 pb-1" : "py-0.5",
        threadOpen && "bg-selected hover:bg-selected",
      )}
    >
      <div className="w-8 shrink-0">
        {head ? (
          <UserAvatar
            name={message.userName}
            image={message.avatarUrl}
            size={32}
            className="mt-0.5 rounded-md"
          />
        ) : (
          <span className="invisible block pt-0.5 text-right text-meta leading-5 text-faint tabular-nums group-hover:visible">
            {messageTime(message.ts)}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {head && (
          <div className="flex items-baseline gap-2">
            <span className="select-text text-item-title font-semibold text-fg">
              {message.userName}
            </span>
            {message.isBot && (
              <span className="rounded-sm bg-hover px-1 text-meta font-medium text-dim">
                App
              </span>
            )}
            <span className="text-meta text-faint tabular-nums">
              {messageTime(message.ts)}
            </span>
          </div>
        )}
        {message.broadcast && (
          <div className="text-meta text-faint">Replied to a thread</div>
        )}
        {message.text && <SlackText text={message.text} />}
        {message.edited && (
          <span className="text-meta text-faint">(edited)</span>
        )}
        {!!message.files?.length && <Files files={message.files} />}
        {!!message.reactions?.length && (
          <Reactions
            reactions={message.reactions}
            onToggle={onReact && ((r) => onReact(r.name, r.emoji))}
          />
        )}
        {onOpenThread && replies > 0 && (
          <ListRow
            onClick={onOpenThread}
            className="mt-1 -ml-1 min-h-0 w-auto items-center gap-1.5 px-1 py-0.5 text-meta"
          >
            {!!message.replyUsers?.length && (
              <span className="flex -space-x-1" aria-hidden>
                {message.replyUsers.map((user, index) => (
                  <UserAvatar
                    key={index}
                    name={user.name}
                    image={user.avatarUrl}
                    size={18}
                    className="rounded-sm"
                  />
                ))}
              </span>
            )}
            <span className="font-semibold text-link">
              {replySummary(message)}
            </span>
          </ListRow>
        )}
      </div>
      {(onReact || onOpenThread) && (
        <div
          className={cn(
            "absolute -top-3 right-3 z-10 flex items-center gap-0.5 rounded-control bg-panel p-0.5 shadow-ring-md",
            // Hidden bars take no taps, or they would cover the text above.
            "pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
        >
          {onReact && (
            <Menu.Root>
              <Tooltip label="React">
                <Menu.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconReactionAdd size={18} />}
                      aria-label="React"
                    />
                  }
                />
              </Tooltip>
              <Menu.Popup align="end">
                <div className="flex gap-0.5">
                  {QUICK_REACTIONS.map((reaction) => (
                    <Menu.Item
                      key={reaction.name}
                      aria-label={`:${reaction.name}:`}
                      className="size-9 justify-center p-0 text-dialog-title"
                      onClick={() => onReact(reaction.name, reaction.emoji)}
                    >
                      {reaction.emoji}
                    </Menu.Item>
                  ))}
                </div>
              </Menu.Popup>
            </Menu.Root>
          )}
          {onOpenThread && (
            <Tooltip label="Reply in thread">
              <Button
                variant="ghost"
                size="sm"
                icon={<IconMessage size={18} />}
                aria-label="Reply in thread"
                onClick={onOpenThread}
              />
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
