import { toggleReactionApi } from "../../lib/api/threads";
import { errorMessage } from "../../lib/error-message";
import {
  openMessageComments,
  publishMessageReactions,
  REACTION_EMOJI,
  threadPeople,
  useMessageCommentsSession,
  useMessageReactions,
  useMessageThread,
} from "../../lib/message-comments";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Menu } from "../../ui/menu";
import { toast } from "../../ui/toast";
import { Tooltip } from "../../ui/tooltip";
import { IconMessage, IconReactionAdd } from "../icons";
import { UserAvatar } from "../UserAvatar";
import { getCurrentUser } from "../UserPicker";

/**
 * Comment on a whole message, and react to it: the two actions every message
 * in a conversation offers (a person's turn, the agent's answer, a thread
 * card). A comment opens a side conversation among people that the agent
 * only joins when someone mentions it; see MessageCommentsPane.
 */

/** What the pane quotes for a message: its author and opening text. */
export interface MessageRef {
  entryId: string;
  author: string;
  text: string;
}

function excerpt(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > 600 ? `${plain.slice(0, 599)}…` : plain;
}

export function openCommentsFor(sessionId: string, message: MessageRef): void {
  openMessageComments({
    sessionId,
    entryId: message.entryId,
    excerpt: excerpt(message.text),
    author: message.author,
  });
}

function toggle(sessionId: string, entryId: string, emoji: string) {
  void toggleReactionApi(sessionId, {
    entryId,
    emoji,
    user: getCurrentUser(),
  })
    .then((reactions) => publishMessageReactions(sessionId, reactions))
    .catch((error) =>
      toast(errorMessage(error, "Couldn't add the reaction"), {
        variant: "error",
      }),
    );
}

/** The hover pair: add a reaction, comment. `className` carries the host
 *  row's reveal (hover on pointers, always on touch). */
export function MessageActionButtons({
  message,
  className,
}: {
  message: MessageRef;
  className?: string;
}) {
  const sessionId = useMessageCommentsSession();
  if (!sessionId) return null;
  return (
    <>
      <Menu.Root>
        <Tooltip label="Add reaction">
          <Menu.Trigger
            aria-label="Add reaction"
            className={cn(
              "flex size-7 flex-none items-center justify-center rounded-sm text-faint hover:bg-hover hover:text-dim data-[popup-open]:bg-hover data-[popup-open]:text-dim data-[popup-open]:opacity-100",
              className,
            )}
          >
            <IconReactionAdd size={20} />
          </Menu.Trigger>
        </Tooltip>
        <Menu.Popup side="top" align="start" className="min-w-0">
          <div className="flex gap-0.5 p-0.5" role="group" aria-label="React">
            {REACTION_EMOJI.map((emoji) => (
              <Menu.Item
                key={emoji}
                aria-label={`React ${emoji}`}
                className="size-9 justify-center p-0 text-[18px] phone:size-11"
                onClick={() => toggle(sessionId, message.entryId, emoji)}
              >
                {emoji}
              </Menu.Item>
            ))}
          </div>
        </Menu.Popup>
      </Menu.Root>
      <Tooltip label="Comment">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Comment"
          icon={<IconMessage size={20} />}
          className={cn("size-7 min-h-7 px-0 text-faint", className)}
          onClick={() => openCommentsFor(sessionId, message)}
        />
      </Tooltip>
    </>
  );
}

/**
 * What a message has gathered, under it: reactions you can add to or take
 * back, and the comment thread as "N replies" with who took part. Renders
 * nothing for a message nobody has reacted to or commented on.
 */
export function MessageThreadSummary({
  message,
  align = "start",
  className,
}: {
  message: MessageRef;
  align?: "start" | "end";
  className?: string;
}) {
  const sessionId = useMessageCommentsSession() ?? undefined;
  const thread = useMessageThread(sessionId, message.entryId);
  const reactions = useMessageReactions(sessionId, message.entryId);
  const me = getCurrentUser().trim().toLowerCase();
  const emoji = Object.entries(reactions);
  if (!sessionId || (!thread && emoji.length === 0)) return null;
  const replies = thread ? thread.comments.length : 0;
  const people = thread ? threadPeople(thread) : [];
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1",
        align === "end" && "justify-end",
        className,
      )}
    >
      {emoji.map(([glyph, who]) => {
        const mine = who.some((name) => name.trim().toLowerCase() === me);
        return (
          <Tooltip key={glyph} label={who.join(", ")}>
            <Button
              size="sm"
              variant={mine ? "soft" : "ghost"}
              aria-pressed={mine}
              aria-label={`${glyph} ${who.length}, ${who.join(", ")}`}
              className={cn(
                "min-h-6 gap-1 px-1.5 tabular-nums phone:min-h-9",
                mine && "text-fg",
              )}
              onClick={() => toggle(sessionId, message.entryId, glyph)}
            >
              <span aria-hidden="true">{glyph}</span>
              <span aria-hidden="true">{who.length}</span>
            </Button>
          </Tooltip>
        );
      })}
      {thread && (
        <Button
          size="sm"
          variant="ghost"
          className="min-h-6 gap-1.5 px-1.5 text-link phone:min-h-9"
          onClick={() => openCommentsFor(sessionId, message)}
        >
          <span className="flex items-center" aria-hidden="true">
            {people.slice(0, 3).map((name, i) => (
              <UserAvatar
                key={name}
                name={name}
                size={16}
                className={cn(i > 0 && "-ml-1")}
              />
            ))}
          </span>
          {replies} {replies === 1 ? "comment" : "comments"}
          {thread.status === "resolved" && (
            <span className="text-faint">· Resolved</span>
          )}
        </Button>
      )}
    </div>
  );
}
