import { joinHuddle, leaveHuddle, useHuddles } from "../../lib/huddle";
import { Button } from "../../ui/button";
import { Tooltip } from "../../ui/tooltip";
import { IconCall } from "../icons";
import { UserAvatar } from "../UserAvatar";

/**
 * A channel's call: Open Session's own voice call (lib/huddle.ts) in a room
 * that belongs to the Slack conversation, so everyone who opens the channel
 * here sees who is in it and can join. Slack's own huddles have no API, so
 * this is a call beside the channel rather than Slack's huddle.
 */
export function ChannelCallButton({
  channelId,
  label,
}: {
  channelId: string;
  label: string;
}) {
  const { rooms, call } = useHuddles();
  const roomId = `channel:${channelId}`;
  const people = rooms.find((room) => room.roomId === roomId)?.members ?? [];
  const inside = call?.roomId === roomId;

  if (inside)
    return (
      <Tooltip label="Leave call">
        <Button
          size="sm"
          variant="success"
          icon={<IconCall size={18} />}
          onClick={leaveHuddle}
        >
          In call
        </Button>
      </Tooltip>
    );

  if (people.length > 0)
    return (
      <Tooltip label={`In the call: ${people.map((p) => p.user).join(", ")}`}>
        <Button
          size="sm"
          variant="success"
          icon={<IconCall size={18} />}
          onClick={() => void joinHuddle({ roomId, label })}
        >
          Join call
          <span className="flex -space-x-1" aria-hidden>
            {people.slice(0, 3).map((p) => (
              <UserAvatar key={p.peerId} name={p.user} size={16} />
            ))}
          </span>
        </Button>
      </Tooltip>
    );

  return (
    <Tooltip label="Start a call">
      <Button
        size="sm"
        variant="ghost"
        icon={<IconCall size={18} />}
        aria-label="Start a call"
        onClick={() => void joinHuddle({ roomId, label })}
      />
    </Tooltip>
  );
}
