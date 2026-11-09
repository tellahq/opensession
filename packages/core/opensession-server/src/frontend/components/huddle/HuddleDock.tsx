import { type CSSProperties, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigation } from "../../hooks/useNavigation";
import { useIsPhone } from "../../hooks/useIsPhone";
import {
  bindHuddles,
  canShareScreen,
  huddleRoom,
  inviteToHuddle,
  joinHuddle,
  leaveHuddle,
  setHuddleChatOpen,
  setHuddleMuted,
  setHuddleNotes,
  startScreenShare,
  stopScreenShare,
  useHuddles,
} from "../../lib/huddle";
import { usePeople } from "../../lib/people";
import { useWorkspaceRecord } from "../../lib/workspace-records";
import type { WSClientMessage, WSServerMessage } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Menu } from "../../ui/menu";
import { toast } from "../../ui/toast";
import { Tooltip } from "../../ui/tooltip";
import {
  IconChevronDown,
  IconHeadphones,
  IconMic,
  IconMessage,
  IconMicOff,
  IconPeople,
  IconScreenShare,
} from "../icons";
import { HuddleChat } from "./HuddleChat";
import { HuddleScreen } from "./HuddleScreen";
import { useDockPlacement } from "./useDockPlacement";

interface DockStyle extends CSSProperties {
  "--dock-right"?: string;
  "--dock-bottom"?: string;
}
import { UserAvatar } from "../UserAvatar";
import { getCurrentUser, TEAM } from "../UserPicker";

/**
 * The call wherever the person goes: a small card in the corner while they
 * are in a huddle, with who is inside (a ring on whoever is talking), the
 * screen someone shares, the chat, and mute, share, invite, notes and leave. Also binds the huddle client to the app socket
 * and turns a teammate's invite into a toast with Join.
 */
export function HuddleDock({
  send,
  addHandler,
  connected,
}: {
  send: (message: WSClientMessage) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
}) {
  useEffect(
    () =>
      bindHuddles({
        send,
        addHandler,
        connected,
        onNotice: (text) => toast(text, { variant: "error" }),
        onInvite: (invite) =>
          toast(`${invite.from} invites you to a huddle in ${invite.label}`, {
            duration: 30_000,
            action: {
              label: "Join",
              onClick: () =>
                void joinHuddle({
                  roomId: invite.roomId,
                  label: invite.label,
                  sessionId: invite.sessionId ?? undefined,
                }),
            },
          }),
      }),
    [send, addHandler, connected],
  );
  const { call } = useHuddles();
  if (!call) return null;
  // On the body: an ancestor's transform would pin a fixed card to it.
  return createPortal(<Dock />, document.body);
}

function Dock() {
  const { call, rooms, online, screens } = useHuddles();
  const workspace = useWorkspaceRecord(
    call?.roomId.startsWith("workspace:")
      ? call.roomId.slice("workspace:".length)
      : null,
  );
  const phone = useIsPhone();
  const navigation = useNavigation();
  const [collapsed, setCollapsed] = useState(false);
  // Beside an open side panel and above the composer, not over either.
  const placement = useDockPlacement(!phone);
  usePeople();
  if (!call) return null;
  const room =
    rooms.find((r) => r.roomId === call.roomId) ?? huddleRoom(call.roomId);
  const members = room?.members ?? [];
  const speaking = new Set(call.speaking);
  const inside = new Set(members.map((m) => m.user.toLowerCase()));
  const me = getCurrentUser().toLowerCase();
  // The roster, whoever is online, and the space's own people.
  const invitable = [
    ...new Map(
      [
        ...TEAM,
        ...online,
        ...(workspace
          ? [
              workspace.createdBy,
              ...(workspace.collaborators ?? []).map((c) => c.name),
            ]
          : []),
      ]
        .filter((name) => name && name !== "Anonymous")
        .map((name) => [name.toLowerCase(), name]),
    ).values(),
  ].filter((name) => {
    const key = name.toLowerCase();
    return key !== me && !inside.has(key);
  });
  const alone = call.status === "live" && members.length <= 1;
  const sharers = members.filter((m) => m.sharing && m.peerId !== call.peerId);
  const watching = sharers.some((m) => screens[m.peerId]);
  const sharable = canShareScreen();
  const dockStyle: DockStyle = {
    "--dock-right": `${placement.right}px`,
    "--dock-bottom": `${placement.bottom}px`,
  };

  return (
    <section
      aria-label="Huddle"
      style={dockStyle}
      className={cn(
        "fixed z-50 flex flex-col gap-2 rounded-xl border border-divider bg-raised p-2.5 smooth-shadow-md",
        phone
          ? "inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))]"
          : cn(
              "right-[var(--dock-right)] bottom-[var(--dock-bottom)]",
              watching && !collapsed ? "w-[420px]" : "w-[320px]",
            ),
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-green-soft text-green">
          <IconHeadphones size={16} />
        </span>
        <Button
          size="sm"
          variant="ghost"
          title="Go to the huddle's conversation"
          className="min-w-0 flex-1 justify-start px-1 font-semibold text-fg"
          onClick={() => {
            if (call.sessionId) navigation.openSession(call.sessionId);
          }}
        >
          <span className="truncate">{call.label}</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={collapsed ? "Expand huddle" : "Collapse huddle"}
          icon={
            <IconChevronDown
              size={18}
              className={cn(collapsed && "rotate-180")}
            />
          }
          className="phone:size-11"
          onClick={() => setCollapsed(!collapsed)}
        />
      </div>

      {!collapsed && (
        <>
          <div
            className="flex flex-wrap gap-2 px-0.5"
            aria-label="In the huddle"
          >
            {members.map((m) => (
              <span
                key={m.peerId}
                className="flex items-center gap-1.5 text-meta text-dim"
                title={m.muted ? `${m.user} (muted)` : m.user}
              >
                <span
                  className={cn(
                    "rounded-full ring-2 ring-transparent ring-offset-1 ring-offset-raised transition-shadow",
                    speaking.has(m.peerId) && "ring-green",
                  )}
                >
                  <UserAvatar name={m.user} size={24} />
                </span>
                <span className="max-w-[90px] truncate">{m.user}</span>
                {m.muted && <IconMicOff size={14} className="text-faint" />}
                {m.sharing && (
                  <IconScreenShare
                    size={14}
                    className="text-accent"
                    aria-label="Sharing their screen"
                  />
                )}
              </span>
            ))}
          </div>
          {call.status === "connecting" ? (
            <p className="m-0 px-0.5 text-meta text-faint">Connecting…</p>
          ) : alone ? (
            <p className="m-0 px-0.5 text-meta text-faint">
              Nobody else is here yet. Invite someone to talk.
            </p>
          ) : null}
          {room?.notes && (
            <p className="m-0 px-0.5 text-meta text-dim">
              Notes are on. Everyone's microphone and the chat are transcribed,
              and a summary is posted when the huddle ends.
            </p>
          )}
          <HuddleScreen
            sharers={sharers}
            screens={screens}
            ownScreen={call.screen}
          />
          {call.chatOpen && <HuddleChat messages={call.chat} />}
        </>
      )}

      <div className="flex items-center gap-1">
        <Tooltip label={call.muted ? "Unmute" : "Mute"}>
          <Button
            size="sm"
            variant={call.muted ? "danger" : "soft"}
            aria-label={call.muted ? "Unmute" : "Mute"}
            aria-pressed={call.muted}
            icon={call.muted ? <IconMicOff size={20} /> : <IconMic size={20} />}
            className="phone:size-11"
            onClick={() => setHuddleMuted(!call.muted)}
          />
        </Tooltip>
        {sharable && (
          <Tooltip label={call.screen ? "Stop sharing" : "Share your screen"}>
            <Button
              size="sm"
              variant={call.screen ? "success" : "soft"}
              aria-label={call.screen ? "Stop sharing" : "Share your screen"}
              aria-pressed={!!call.screen}
              icon={<IconScreenShare size={20} />}
              className="phone:size-11"
              disabled={call.status !== "live"}
              onClick={() =>
                call.screen ? stopScreenShare() : void startScreenShare()
              }
            />
          </Tooltip>
        )}
        <Tooltip label={call.chatOpen ? "Hide chat" : "Chat"}>
          <span className="relative inline-flex">
            <Button
              size="sm"
              variant={call.chatOpen ? "success" : "soft"}
              aria-label={
                call.unread > 0
                  ? `Chat, ${call.unread} unread`
                  : call.chatOpen
                    ? "Hide chat"
                    : "Chat"
              }
              aria-pressed={call.chatOpen}
              icon={<IconMessage size={20} />}
              className="phone:size-11"
              onClick={() => {
                setHuddleChatOpen(!call.chatOpen);
                if (!call.chatOpen) setCollapsed(false);
              }}
            />
            {call.unread > 0 && (
              <span
                aria-hidden
                className="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-on-accent tabular-nums"
              >
                {call.unread > 9 ? "9+" : call.unread}
              </span>
            )}
          </span>
        </Tooltip>
        <Menu.Root>
          <Tooltip label="Invite">
            <Menu.Trigger
              render={
                <Button
                  size="sm"
                  variant="soft"
                  aria-label="Invite to huddle"
                  icon={<IconPeople size={20} />}
                  className="phone:size-11"
                />
              }
            />
          </Tooltip>
          <Menu.Popup side="top" align="start" className="min-w-[200px]">
            {invitable.length === 0 ? (
              <div className="px-2.5 py-1.5 text-meta text-faint">
                Everyone is already here.
              </div>
            ) : (
              invitable.map((name) => (
                <Menu.Item
                  key={name}
                  onClick={() => {
                    inviteToHuddle(name);
                    toast(`Invited ${name}`);
                  }}
                >
                  <UserAvatar name={name} size={22} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </Menu.Item>
              ))
            )}
          </Menu.Popup>
        </Menu.Root>
        <Tooltip
          label={
            room?.notes
              ? "Stop notes"
              : "Take notes: transcribe and summarize this huddle"
          }
        >
          <Button
            size="sm"
            variant={room?.notes ? "success" : "soft"}
            aria-pressed={!!room?.notes}
            className="phone:min-h-11"
            disabled={call.status !== "live"}
            onClick={() => setHuddleNotes(!room?.notes)}
          >
            Notes
          </Button>
        </Tooltip>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="danger-strong"
          className="phone:min-h-11"
          onClick={leaveHuddle}
        >
          Leave
        </Button>
      </div>
    </section>
  );
}
