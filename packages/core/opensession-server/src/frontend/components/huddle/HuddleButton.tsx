import { joinHuddle, leaveHuddle, useHuddles } from "../../lib/huddle";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconHeadphones } from "../icons";
import { UserAvatar } from "../UserAvatar";

/** The huddle a session belongs to: its workspace's (a space is one), else its own. */
export function huddleTarget(session: {
  id: string;
  title: string;
  workspaceId?: string | null;
  workspaceName?: string;
}): { roomId: string; label: string; sessionId: string } {
  return session.workspaceId
    ? {
        roomId: `workspace:${session.workspaceId}`,
        label: session.workspaceName || session.title,
        sessionId: session.id,
      }
    : {
        roomId: `session:${session.id}`,
        label: session.title,
        sessionId: session.id,
      };
}

/**
 * Start, join or leave the huddle here. Quiet headphones when nobody is in
 * it; a green "Join huddle" with who is inside when somebody is.
 */
export function HuddleButton({
  target,
  compact,
}: {
  target: { roomId: string; label: string; sessionId: string };
  /** Icon only (phone header). */
  compact?: boolean;
}) {
  const { rooms, call } = useHuddles();
  const room = rooms.find((r) => r.roomId === target.roomId) ?? null;
  const inside = call?.roomId === target.roomId;
  const people = room?.members ?? [];

  if (inside)
    return (
      <Tooltip label="Leave huddle">
        <Button
          size="sm"
          variant="success"
          icon={<IconHeadphones size={20} />}
          aria-label="Leave huddle"
          className={cn(compact && "size-8 px-0")}
          onClick={leaveHuddle}
        >
          {compact ? undefined : "In huddle"}
        </Button>
      </Tooltip>
    );

  if (people.length > 0)
    return (
      <Tooltip label={`In the huddle: ${people.map((p) => p.user).join(", ")}`}>
        <Button
          size="sm"
          variant="success"
          aria-label="Join huddle"
          icon={<IconHeadphones size={20} />}
          className={cn("gap-1.5", compact && "px-1.5")}
          onClick={() => void joinHuddle(target)}
        >
          {!compact && "Join huddle"}
          <span className="flex -space-x-1" aria-hidden="true">
            {people.slice(0, 3).map((p) => (
              <UserAvatar key={p.peerId} name={p.user} size={16} />
            ))}
          </span>
        </Button>
      </Tooltip>
    );

  return (
    <Tooltip label="Start huddle">
      <Button
        size="md"
        variant="ghost"
        aria-label="Start huddle"
        icon={<IconHeadphones size={20} />}
        className="flex-none rounded-control"
        onClick={() => void joinHuddle(target)}
      />
    </Tooltip>
  );
}
