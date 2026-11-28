import { useEffect, useRef, useState } from "react";
import { decodeSlackMentions } from "../../../shared/slack-mentions";
import type {
  ChannelMessage,
  MessageReaction,
} from "../../lib/api/slack-channels";
import { fetchSlackUsers } from "../../lib/api/shipped-changes";
import { fetchPermalink, fileSrc } from "../../lib/api/slack-channels";
import { messageTime, replySummary, timeAgo } from "../../lib/channel-messages";
import { errorMessage } from "../../lib/error-message";
import { copyToClipboard } from "../../lib/share-link";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { MENU_ICON, Menu } from "../../ui/menu";
import { toast } from "../../ui/toast";
import { Tooltip } from "../../ui/tooltip";
import {
  IconCopy,
  IconDotsVertical,
  IconFile,
  IconArrowRight,
  IconLink,
  IconMessage,
  IconPencil,
  IconReactionAdd,
  IconShare,
  IconTrash,
} from "../icons";
import { UserAvatar } from "../UserAvatar";
import { ChannelComposer } from "./ChannelComposer";
import { EmojiPicker } from "./EmojiPicker";
import { RichAttachments, RichBlocks } from "./RichContent";
import { SlackText } from "./SlackText";

const JUMP_GLYPH = <IconArrowRight size={22} />;

function Reactions({
  reactions,
  onToggle,
  onAdd,
}: {
  reactions: MessageReaction[];
  onToggle?: (reaction: MessageReaction) => void;
  onAdd?: (name: string, emoji?: string) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {reactions.map((r) => (
        <ListRow
          key={r.name}
          title={`:${r.name}:`}
          aria-pressed={!!r.mine}
          disabled={!onToggle}
          onClick={() => onToggle?.(r)}
          className={cn(
            "inline-flex h-6 min-h-0 w-auto items-center gap-1 rounded-full border px-2 py-0 text-meta leading-none",
            r.mine
              ? "border-accent bg-accent-soft text-accent-ink"
              : "border-transparent bg-hover text-dim hover:border-line-strong",
          )}
        >
          {r.url ? (
            <img src={r.url} alt={r.name} className="size-4" />
          ) : (
            <span className="text-label">{r.emoji || `:${r.name}:`}</span>
          )}
          <span className="font-medium tabular-nums">{r.count}</span>
        </ListRow>
      ))}
      {onAdd && (
        // Slack's trailing pill: one more reaction without the hover bar.
        <EmojiPicker
          side="bottom"
          align="start"
          onPick={(entry) => onAdd(entry.name, entry.char)}
          trigger={
            <ListRow
              aria-label="Add reaction"
              className="inline-flex h-6 min-h-0 w-auto items-center rounded-full border border-transparent bg-hover px-2 py-0 text-dim opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:border-line-strong [@media(hover:none)]:opacity-100"
            >
              <IconReactionAdd size={20} />
            </ListRow>
          }
        />
      )}
    </div>
  );
}

function Files({ files }: { files: NonNullable<ChannelMessage["files"]> }) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {files.map((file, index) =>
        file.thumb ? (
          <div key={index} className="flex flex-col gap-1">
            <span className="truncate text-meta text-faint">{file.name}</span>
            <a
              href={file.permalink}
              target="_blank"
              rel="noreferrer"
              className="block w-fit max-w-[min(100%,480px)] overflow-hidden rounded-lg border border-line"
            >
              <img
                src={fileSrc(file.thumb)}
                alt={file.name}
                loading="lazy"
                width={file.width}
                height={file.height}
                className="block h-auto max-h-[360px] w-auto max-w-full object-contain"
              />
            </a>
          </div>
        ) : (
          <a
            key={index}
            href={file.permalink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit max-w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-body text-fg hover:bg-hover"
          >
            <IconFile size={20} className="shrink-0 text-dim" />
            <span className="truncate">{file.name}</span>
          </a>
        ),
      )}
    </div>
  );
}

/**
 * Slack's in-place edit: the composer over the message's own text, with
 * Cancel and Save. Picked people read as "@name" again, so the roster loads
 * first (it is cached after the first composer focus).
 */
function MessageEditor({
  source,
  onSave,
  onCancel,
}: {
  source: string;
  onSave: (text: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [initial, setInitial] = useState<ReturnType<
    typeof decodeSlackMentions
  > | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initial) box.current?.scrollIntoView({ block: "nearest" });
  }, [initial]);
  useEffect(() => {
    let alive = true;
    void fetchSlackUsers().then(
      (users) => alive && setInitial(decodeSlackMentions(source, users)),
    );
    return () => {
      alive = false;
    };
  }, [source]);
  if (!initial) return null;
  return (
    <div ref={box} className="mt-1 mb-1">
      <ChannelComposer
        placeholder="Edit message"
        disabled={false}
        initial={initial}
        onSend={(text) => onSave(text)}
        onCancel={onCancel}
      />
    </div>
  );
}

async function withPermalink(
  channelId: string,
  ts: string,
  use: (url: string) => void,
) {
  await fetchPermalink(channelId, ts)
    .then(({ url }) => use(url))
    .catch((e) =>
      toast(errorMessage(e, "Couldn't get the message link"), {
        variant: "error",
      }),
    );
}

/**
 * One Slack message, laid out as Slack lays it out. The first of a run shows
 * its author's photo and name; a follow-up shows only its time, on hover,
 * where the photo would be. Hovering raises Slack's action bar at the top
 * right (react, reply in thread, copy link, more); on a touch screen, which
 * has no hover, tapping the message raises it.
 */
export function ChannelMessageRow({
  message,
  channelId,
  head,
  onReact,
  onOpenThread,
  threadOpen = false,
  editing = false,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onJump,
  inThread = false,
  highlight = false,
  className,
}: {
  message: ChannelMessage;
  channelId: string;
  head: boolean;
  /** Absent without a Slack grant: reading only. */
  onReact?: (name: string, emoji?: string) => void;
  /** Absent inside a thread. */
  onOpenThread?: () => void;
  threadOpen?: boolean;
  /** The person's own message is open in the editor. */
  editing?: boolean;
  /** Present for the person's own message: open it in the editor. */
  onEdit?: () => void;
  onSaveEdit?: (text: string) => Promise<boolean>;
  onCancelEdit?: () => void;
  /** Present for the person's own message: delete it, after a confirm. */
  onDelete?: () => void;
  /** A search result: open its conversation at it. */
  onJump?: () => void;
  /** A search result that is a thread reply. */
  inThread?: boolean;
  /** Just opened at: marked for a moment, as Slack does. */
  highlight?: boolean;
  /** Placement, and a corner for a row inside a rounded card. */
  className?: string;
}) {
  const replies = message.replyCount ?? 0;
  const copyLink = () =>
    void withPermalink(channelId, message.ts, (url) =>
      copyToClipboard(url, () => toast("Link copied")),
    );
  return (
    // Focusable without being a tab stop, so a tap on a touch screen
    // selects the message and shows its actions.
    <div
      tabIndex={-1}
      data-ts={message.ts}
      className={cn(
        "group relative flex gap-2 px-5 outline-none transition-colors duration-long hover:bg-hover focus-within:bg-hover",
        head ? "mt-1 pt-2 pb-1" : "py-0.5",
        (threadOpen || editing || highlight) &&
          "bg-yellow-soft hover:bg-yellow-soft",
        className,
      )}
    >
      <div className="w-9 shrink-0">
        {head ? (
          <UserAvatar
            name={message.userName}
            image={message.avatarUrl}
            size={36}
            className="mt-0.5 rounded-md"
          />
        ) : (
          <span className="invisible block pt-0.5 text-right text-meta leading-5 text-faint tabular-nums group-hover:visible">
            {messageTime(message.ts).replace(/\s?[AP]M$/i, "")}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {head && (
          <div className="flex items-baseline gap-2">
            <span className="select-text text-item-title font-bold text-fg">
              {message.userName}
            </span>
            {message.isBot && (
              <span className="rounded-sm bg-hover px-1 text-meta font-medium text-dim">
                App
              </span>
            )}
            {onJump ? (
              // Slack opens a result from its time, as a link to it.
              <ListRow
                onClick={onJump}
                className="min-h-0 w-auto p-0 text-meta text-faint tabular-nums hover:text-link hover:underline"
              >
                {messageTime(message.ts)}
              </ListRow>
            ) : (
              <span className="text-meta text-faint tabular-nums">
                {messageTime(message.ts)}
              </span>
            )}
          </div>
        )}
        {inThread && (
          <div className="text-meta text-faint">Replied in a thread</div>
        )}
        {message.broadcast && (
          <div className="text-meta text-faint">Replied to a thread</div>
        )}
        {editing && onSaveEdit && onCancelEdit ? (
          <MessageEditor
            source={message.source ?? ""}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
          />
        ) : (
          <>
            {message.text && <SlackText text={message.text} />}
            {message.edited && (
              <span className="text-meta text-faint">(edited)</span>
            )}
          </>
        )}
        {!!message.blocks?.length && <RichBlocks blocks={message.blocks} />}
        {!!message.files?.length && <Files files={message.files} />}
        {!!message.attachments?.length && (
          <RichAttachments attachments={message.attachments} />
        )}
        {!!message.reactions?.length && (
          <Reactions
            reactions={message.reactions}
            onToggle={onReact && ((r) => onReact(r.name, r.emoji))}
            onAdd={onReact}
          />
        )}
        {onOpenThread && replies > 0 && (
          <ListRow
            onClick={onOpenThread}
            className="group/replies mt-1 -ml-1 min-h-0 w-full max-w-[600px] items-center gap-2 rounded-md border border-transparent px-1 py-1 text-meta hover:border-line hover:bg-panel"
          >
            {!!message.replyUsers?.length && (
              <span className="flex gap-1" aria-hidden>
                {message.replyUsers.map((user, index) => (
                  <UserAvatar
                    key={index}
                    name={user.name}
                    image={user.avatarUrl}
                    size={24}
                    className="rounded-md"
                  />
                ))}
              </span>
            )}
            <span className="font-bold text-link">{replySummary(message)}</span>
            {message.latestReply && (
              <span className="truncate text-faint group-hover/replies:hidden">
                Last reply {timeAgo(message.latestReply)}
              </span>
            )}
            <span className="hidden truncate text-faint group-hover/replies:inline">
              View thread
            </span>
          </ListRow>
        )}
      </div>
      {!editing && (
        <div
          className={cn(
            "absolute -top-5 right-5 z-sticky flex items-center gap-0.5 rounded-lg border border-line bg-panel p-1 shadow-ring-sm",
            // Hidden bars take no taps, or they would cover the text above.
            "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
          )}
        >
          {onJump && (
            <Tooltip
              label={inThread ? "Open in thread" : "Open in conversation"}
            >
              <Button
                variant="ghost"
                size="md"
                icon={JUMP_GLYPH}
                aria-label={
                  inThread ? "Open in thread" : "Open in conversation"
                }
                onClick={onJump}
              />
            </Tooltip>
          )}
          {onReact && (
            <EmojiPicker
              side="bottom"
              tooltip="Add reaction…"
              onPick={(entry) => onReact(entry.name, entry.char)}
              trigger={
                <Button
                  variant="ghost"
                  size="md"
                  icon={<IconReactionAdd size={22} />}
                  aria-label="Add reaction"
                />
              }
            />
          )}
          {onOpenThread && (
            <Tooltip label="Reply in thread">
              <Button
                variant="ghost"
                size="md"
                icon={<IconMessage size={22} />}
                aria-label="Reply in thread"
                onClick={onOpenThread}
              />
            </Tooltip>
          )}
          <Tooltip label="Copy link">
            <Button
              variant="ghost"
              size="md"
              icon={<IconLink size={22} />}
              aria-label="Copy link"
              onClick={copyLink}
            />
          </Tooltip>
          <Menu.Root>
            <Tooltip label="More actions">
              <Menu.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="md"
                    icon={<IconDotsVertical size={22} />}
                    aria-label="More actions"
                  />
                }
              />
            </Tooltip>
            <Menu.Popup align="end">
              <Menu.Item
                onClick={() =>
                  copyToClipboard(message.text, () => toast("Text copied"))
                }
              >
                <IconCopy size={20} className={MENU_ICON} />
                <span className="grow">Copy text</span>
              </Menu.Item>
              <Menu.Item onClick={copyLink}>
                <IconLink size={20} className={MENU_ICON} />
                <span className="grow">Copy link</span>
              </Menu.Item>
              <Menu.Item
                onClick={() =>
                  void withPermalink(channelId, message.ts, (url) =>
                    window.open(url, "_blank", "noopener"),
                  )
                }
              >
                <IconShare size={20} className={MENU_ICON} />
                <span className="grow">Open in Slack</span>
              </Menu.Item>
              {(onEdit || onDelete) && <Menu.Separator />}
              {onEdit && (
                <Menu.Item onClick={onEdit}>
                  <IconPencil size={20} className={MENU_ICON} />
                  <span className="grow">Edit message</span>
                </Menu.Item>
              )}
              {onDelete && (
                <Menu.Item
                  onClick={onDelete}
                  className="text-red data-[highlighted]:bg-red-soft data-[highlighted]:text-red"
                >
                  <IconTrash size={20} />
                  <span className="grow">Delete message</span>
                </Menu.Item>
              )}
            </Menu.Popup>
          </Menu.Root>
        </div>
      )}
    </div>
  );
}
