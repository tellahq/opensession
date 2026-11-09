import { describe, expect, test } from "bun:test";
import { createHuddles, huddleIceServers, MAX_HUDDLE_MEMBERS } from "./huddles";

function socket(user: string) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    data: { user },
    send: (raw: string) => sent.push(JSON.parse(raw)),
    last: (type: string) => sent.filter((m) => m.type === type).at(-1),
  };
}

function setup() {
  const clients: Array<ReturnType<typeof socket>> = [];
  const summaries: Array<{ roomId: string; lines: number }> = [];
  let n = 0;
  const hub = createHuddles({
    clients: () => clients,
    summarize: async (room, transcript) => {
      summaries.push({ roomId: room.roomId, lines: transcript.length });
    },
    now: () => 1_000,
    newId: () => `peer-${++n}`,
  });
  const connect = (user: string) => {
    const ws = socket(user);
    clients.push(ws);
    return ws;
  };
  return { hub, connect, summaries };
}

const join = (roomId = "session:bks-a") => ({
  type: "huddle_join",
  roomId,
  label: "Checkout",
  sessionId: "bks-a",
});

describe("huddles", () => {
  test("the newcomer gets the peers already inside and everyone hears the room", () => {
    const { hub, connect } = setup();
    const ada = connect("Ada");
    const grace = connect("Grace");
    hub.message(ada, join());
    hub.message(grace, join());
    expect(ada.last("huddle_joined")).toMatchObject({
      peerId: "peer-1",
      peers: [],
    });
    expect(grace.last("huddle_joined")).toMatchObject({
      peerId: "peer-2",
      peers: ["peer-1"],
    });
    const rooms = ada.last("huddles")?.rooms as Array<{
      members: Array<{ user: string }>;
    }>;
    expect(rooms[0]?.members.map((m) => m.user)).toEqual(["Ada", "Grace"]);
  });

  test("relays a signal only to the named peer in the same room", () => {
    const { hub, connect } = setup();
    const ada = connect("Ada");
    const grace = connect("Grace");
    const linus = connect("Linus");
    hub.message(ada, join());
    hub.message(grace, join());
    hub.message(linus, join("session:other"));
    hub.message(grace, {
      type: "huddle_signal",
      to: "peer-1",
      data: { sdp: { type: "offer", sdp: "v=0" } },
    });
    expect(ada.last("huddle_signal")).toEqual({
      type: "huddle_signal",
      from: "peer-2",
      data: { sdp: { type: "offer", sdp: "v=0" } },
    });
    expect(linus.last("huddle_signal")).toBeUndefined();
  });

  test("one huddle at a time, and an empty room closes", () => {
    const { hub, connect } = setup();
    const ada = connect("Ada");
    hub.message(ada, join());
    hub.message(ada, join("workspace:ws-b"));
    expect(hub.rooms().map((r) => r.roomId)).toEqual(["workspace:ws-b"]);
    hub.close(ada);
    expect(hub.rooms()).toEqual([]);
  });

  test("an invite reaches every socket of that person and reports back", () => {
    const { hub, connect } = setup();
    const ada = connect("Ada");
    const graceLaptop = connect("Grace");
    const gracePhone = connect("grace");
    hub.message(ada, join());
    hub.message(ada, { type: "huddle_invite", to: "Grace" });
    expect(graceLaptop.last("huddle_invite")).toMatchObject({
      from: "Ada",
      label: "Checkout",
      roomId: "session:bks-a",
    });
    expect(gracePhone.last("huddle_invite")).toBeDefined();
    expect(ada.last("huddle_invite_result")).toMatchObject({ delivered: 2 });
    hub.message(ada, { type: "huddle_invite", to: "Nobody" });
    expect(ada.last("huddle_invite_result")).toMatchObject({ delivered: 0 });
  });

  test("notes are kept only while on, and summarized when the last person leaves", () => {
    const { hub, connect, summaries } = setup();
    const ada = connect("Ada");
    hub.message(ada, join());
    hub.message(ada, { type: "huddle_note", text: "before" });
    hub.message(ada, { type: "huddle_notes", on: true });
    hub.message(ada, { type: "huddle_note", text: "ship it" });
    hub.message(ada, { type: "huddle_leave" });
    expect(summaries).toEqual([{ roomId: "session:bks-a", lines: 1 }]);
  });

  test("chat reaches only the room, and a newcomer gets what was said", () => {
    const { hub, connect, summaries } = setup();
    const ada = connect("Ada");
    const grace = connect("Grace");
    const linus = connect("Linus");
    hub.message(ada, join());
    hub.message(linus, join("session:other"));
    hub.message(ada, { type: "huddle_chat", text: "  link: example.test  " });
    hub.message(ada, { type: "huddle_chat", text: "   " });
    expect(ada.last("huddle_chat")).toMatchObject({
      roomId: "session:bks-a",
      message: { user: "Ada", text: "link: example.test" },
    });
    expect(linus.last("huddle_chat")).toBeUndefined();
    hub.message(grace, join());
    expect(
      (grace.last("huddle_joined")?.chat as Array<{ text: string }>).map(
        (m) => m.text,
      ),
    ).toEqual(["link: example.test"]);
    // Typed lines join the notes once they are on.
    hub.message(ada, { type: "huddle_notes", on: true });
    hub.message(grace, { type: "huddle_chat", text: "ship it" });
    hub.close(ada);
    hub.close(grace);
    expect(summaries).toEqual([{ roomId: "session:bks-a", lines: 1 }]);
  });

  test("sharing a screen is announced to everyone", () => {
    const { hub, connect } = setup();
    const ada = connect("Ada");
    const grace = connect("Grace");
    hub.message(ada, join());
    hub.message(grace, join());
    hub.message(ada, { type: "huddle_share", on: true });
    const rooms = grace.last("huddles")?.rooms as Array<{
      members: Array<{ user: string; sharing: boolean }>;
    }>;
    expect(rooms[0]?.members).toMatchObject([
      { user: "Ada", sharing: true },
      { user: "Grace", sharing: false },
    ]);
  });

  test("a full room turns the next person away", () => {
    const { hub, connect } = setup();
    for (let i = 0; i < MAX_HUDDLE_MEMBERS; i++)
      hub.message(connect(`P${i}`), join());
    const late = connect("Late");
    hub.message(late, join());
    expect(late.last("huddle_error")).toBeDefined();
    expect(hub.rooms()[0]?.members).toHaveLength(MAX_HUDDLE_MEMBERS);
  });

  test("ignores other frames and drops malformed huddle ones", () => {
    const { hub, connect } = setup();
    const ada = connect("Ada");
    expect(hub.message(ada, { type: "ping" })).toBe(false);
    expect(hub.message(ada, { type: "huddle_join", roomId: "../etc" })).toBe(
      true,
    );
    expect(hub.rooms()).toEqual([]);
  });

  test("reads ICE servers from config and falls back to none", () => {
    expect(huddleIceServers(undefined)).toEqual([]);
    expect(huddleIceServers("nope")).toEqual([]);
    expect(huddleIceServers('[{"urls":"stun:stun.example.test"}]')).toEqual([
      { urls: "stun:stun.example.test" },
    ]);
  });
});
