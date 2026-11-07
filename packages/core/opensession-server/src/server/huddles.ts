/**
 * Huddles: voice calls that live inside a session, a workspace or a space.
 *
 * Audio flows browser to browser over WebRTC (a full mesh, which suits the
 * handful of people a huddle holds). This module is only the switchboard: it
 * keeps who is in which room in memory, relays the offers, answers and ICE
 * candidates between peers over the existing WebSocket, and delivers
 * invites. Nothing is persisted except, when someone turned notes on, the
 * call's summary, which lands as a team note on the session the huddle
 * started from once the last person leaves.
 *
 * Rooms are keyed `session:<id>` or `workspace:<id>`. The ICE servers come
 * from OPENSESSION_HUDDLE_ICE_SERVERS (a JSON RTCIceServer list); without
 * it, peers only find each other on networks that reach one another
 * directly.
 */

import { z } from "zod";

export interface HuddleSocket {
  data: { user: string | null; authUser?: string | null };
  send(data: string): unknown;
}

export interface HuddleMember {
  peerId: string;
  user: string;
  muted: boolean;
  joinedAt: number;
}

interface NoteLine {
  user: string;
  at: number;
  text: string;
}

interface Room {
  id: string;
  label: string;
  /** Where the summary goes: the session the huddle was started from. */
  sessionId: string | null;
  startedAt: number;
  notes: boolean;
  transcript: NoteLine[];
  members: Map<HuddleSocket, HuddleMember>;
}

export interface HuddleRoomState {
  roomId: string;
  label: string;
  sessionId: string | null;
  startedAt: number;
  notes: boolean;
  members: HuddleMember[];
}

/** A mesh past this many people costs every browser more than it can send. */
export const MAX_HUDDLE_MEMBERS = 8;
const MAX_TRANSCRIPT_LINES = 2_000;
const MAX_NOTE_CHARS = 2_000;

const ROOM_ID = /^(session|workspace):[\w.-]{1,128}$/;

const iceServerSchema = z.array(
  z.object({
    urls: z.union([z.string(), z.array(z.string())]),
    username: z.string().optional(),
    credential: z.string().optional(),
  }),
);

export function huddleIceServers(
  raw = process.env.OPENSESSION_HUDDLE_ICE_SERVERS,
): z.infer<typeof iceServerSchema> {
  if (!raw) return [];
  try {
    const parsed = iceServerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const joinSchema = z.object({
  type: z.literal("huddle_join"),
  roomId: z.string().regex(ROOM_ID),
  label: z.string().max(200).optional(),
  sessionId: z.string().max(200).optional(),
});
const leaveSchema = z.object({ type: z.literal("huddle_leave") });
const signalSchema = z.object({
  type: z.literal("huddle_signal"),
  to: z.string().max(64),
  data: z.object({
    sdp: z
      .object({
        type: z.enum(["offer", "answer"]),
        sdp: z.string().max(100_000),
      })
      .optional(),
    candidate: z
      .object({
        candidate: z.string().max(2_000),
        sdpMid: z.string().max(64).nullable().optional(),
        sdpMLineIndex: z.number().int().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
});
const muteSchema = z.object({
  type: z.literal("huddle_mute"),
  muted: z.boolean(),
});
const notesSchema = z.object({
  type: z.literal("huddle_notes"),
  on: z.boolean(),
});
const noteSchema = z.object({
  type: z.literal("huddle_note"),
  text: z.string().min(1).max(MAX_NOTE_CHARS),
});
const inviteSchema = z.object({
  type: z.literal("huddle_invite"),
  to: z.string().min(1).max(64),
});
const subscribeSchema = z.object({ type: z.literal("huddles_subscribe") });

const messageSchema = z.discriminatedUnion("type", [
  joinSchema,
  leaveSchema,
  signalSchema,
  muteSchema,
  notesSchema,
  noteSchema,
  inviteSchema,
  subscribeSchema,
]);

export interface HuddleDeps {
  /** Every connected socket, to reach an invitee and announce rooms. */
  clients: () => Iterable<HuddleSocket>;
  /** Write a finished call's notes; best effort. */
  summarize: (room: HuddleRoomState, transcript: NoteLine[]) => Promise<void>;
  now: () => number;
  newId: () => string;
}

export function createHuddles(deps: HuddleDeps) {
  const rooms = new Map<string, Room>();
  const roomOf = new Map<HuddleSocket, Room>();

  const identity = (ws: HuddleSocket) =>
    (ws.data.authUser || ws.data.user || "").trim() || "Someone";

  const send = (ws: HuddleSocket, msg: object) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  };

  const state = (room: Room): HuddleRoomState => ({
    roomId: room.id,
    label: room.label,
    sessionId: room.sessionId,
    startedAt: room.startedAt,
    notes: room.notes,
    members: [...room.members.values()],
  });

  const snapshot = () => ({
    type: "huddles",
    rooms: [...rooms.values()].map(state),
  });

  /** Every client hears every room: who is in a call is presence. */
  const announce = () => {
    const payload = JSON.stringify(snapshot());
    for (const ws of deps.clients()) {
      try {
        ws.send(payload);
      } catch {}
    }
  };

  function leave(ws: HuddleSocket) {
    const room = roomOf.get(ws);
    if (!room) return;
    roomOf.delete(ws);
    room.members.delete(ws);
    if (room.members.size === 0) {
      rooms.delete(room.id);
      if (room.notes && room.transcript.length > 0) {
        const finished = state(room);
        void deps
          .summarize(finished, room.transcript)
          .catch((error) =>
            console.warn(
              "[huddles] summary failed:",
              error instanceof Error ? error.message : String(error),
            ),
          );
      }
    }
    announce();
  }

  function join(ws: HuddleSocket, msg: z.infer<typeof joinSchema>) {
    // One huddle at a time: joining another leaves the current one.
    if (roomOf.get(ws)?.id === msg.roomId) return;
    leave(ws);
    let room = rooms.get(msg.roomId);
    if (room && room.members.size >= MAX_HUDDLE_MEMBERS) {
      send(ws, {
        type: "huddle_error",
        message: `This huddle is full (${MAX_HUDDLE_MEMBERS} people).`,
      });
      return;
    }
    if (!room) {
      room = {
        id: msg.roomId,
        label: msg.label?.trim() || "Huddle",
        sessionId: msg.sessionId ?? null,
        startedAt: deps.now(),
        notes: false,
        transcript: [],
        members: new Map(),
      };
      rooms.set(room.id, room);
    }
    const member: HuddleMember = {
      peerId: deps.newId(),
      user: identity(ws),
      muted: false,
      joinedAt: deps.now(),
    };
    const peers = [...room.members.values()].map((m) => m.peerId);
    room.members.set(ws, member);
    roomOf.set(ws, room);
    // The newcomer calls everyone already inside, so two offers never cross.
    send(ws, {
      type: "huddle_joined",
      roomId: room.id,
      peerId: member.peerId,
      peers,
      iceServers: huddleIceServers(),
    });
    announce();
  }

  function signal(ws: HuddleSocket, msg: z.infer<typeof signalSchema>) {
    const room = roomOf.get(ws);
    const from = room?.members.get(ws);
    if (!room || !from) return;
    for (const [peer, member] of room.members)
      if (member.peerId === msg.to)
        send(peer, {
          type: "huddle_signal",
          from: from.peerId,
          data: msg.data,
        });
  }

  function invite(ws: HuddleSocket, msg: z.infer<typeof inviteSchema>) {
    const room = roomOf.get(ws);
    if (!room) return;
    const wanted = msg.to.trim().toLowerCase();
    let delivered = 0;
    for (const client of deps.clients()) {
      if (identity(client).toLowerCase() !== wanted) continue;
      send(client, {
        type: "huddle_invite",
        roomId: room.id,
        label: room.label,
        sessionId: room.sessionId,
        from: identity(ws),
      });
      delivered++;
    }
    send(ws, { type: "huddle_invite_result", to: msg.to, delivered });
  }

  return {
    /** Handle a huddle frame. False when `raw` is not one. */
    message(ws: HuddleSocket, raw: Record<string, unknown>): boolean {
      const kind = raw.type;
      if (typeof kind !== "string" || !kind.startsWith("huddle")) return false;
      const parsed = messageSchema.safeParse(raw);
      if (!parsed.success) return true;
      const msg = parsed.data;
      switch (msg.type) {
        case "huddles_subscribe":
          send(ws, snapshot());
          break;
        case "huddle_join":
          join(ws, msg);
          break;
        case "huddle_leave":
          leave(ws);
          break;
        case "huddle_signal":
          signal(ws, msg);
          break;
        case "huddle_mute": {
          const member = roomOf.get(ws)?.members.get(ws);
          if (member && member.muted !== msg.muted) {
            member.muted = msg.muted;
            announce();
          }
          break;
        }
        case "huddle_notes": {
          const room = roomOf.get(ws);
          if (room && room.notes !== msg.on) {
            room.notes = msg.on;
            announce();
          }
          break;
        }
        case "huddle_note": {
          const room = roomOf.get(ws);
          if (!room?.notes || room.transcript.length >= MAX_TRANSCRIPT_LINES)
            break;
          room.transcript.push({
            user: identity(ws),
            at: deps.now(),
            text: msg.text.trim(),
          });
          break;
        }
        case "huddle_invite":
          invite(ws, msg);
          break;
      }
      return true;
    },
    close: leave,
    rooms: () => [...rooms.values()].map(state),
  };
}
