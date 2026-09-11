import { describe, expect, test } from "bun:test";
import { DeskVoiceNavigation } from "./desk-voice-navigation";
import { handleDeskVoiceRoutes } from "./routes/desk-voice";
import { deskNavigationRequestSchema } from "../shared/desk-navigation";

const target = { kind: "session", id: "s-1" } as const;
const poll = (token: string) =>
  ({ action: "poll", token, liveSessionId: "call" }) as const;

describe("call-bound voice navigation", () => {
  test("rejects a different login, missing identity, or another tab's token", async () => {
    const nav = new DeskVoiceNavigation("alice-login");
    const result = nav.show(target);
    expect(nav.handle("other-alice-login", poll(nav.token))).toBeNull();
    expect(nav.handle("", poll(nav.token))).toBeNull();
    expect(nav.handle("alice-login", poll(crypto.randomUUID()))).toBeNull();
    expect(nav.handle("ALICE-LOGIN", poll(nav.token))).toMatchObject({
      command: { target },
    });
    nav.close();
    expect(await result).toMatchObject({ shown: false });
    expect(nav.handle("alice-login", poll(nav.token))).toBeNull();
    expect(await nav.show(target)).toMatchObject({ shown: false });
  });

  test("bounds pending work, rejects wrong acknowledgments, and reports browser failure", async () => {
    const nav = new DeskVoiceNavigation("alice");
    const result = nav.show(target);
    expect(await nav.show(target)).toMatchObject({ shown: false });
    const response = nav.handle("alice", poll(nav.token));
    if (!response || !("command" in response) || !response.command)
      throw new Error("missing command");
    const ack = {
      action: "ack",
      liveSessionId: "call",
      token: nav.token,
      commandId: response.command.id,
      shown: false,
    } as const;
    expect(nav.handle("other", ack)).toBeNull();
    expect(
      nav.handle("alice", { ...ack, commandId: crypto.randomUUID() }),
    ).toEqual({ ok: false });
    expect(nav.handle("alice", ack)).toEqual({ ok: true });
    expect(await result).toMatchObject({
      shown: false,
      error: expect.stringContaining("could not show"),
    });
    expect(nav.handle("alice", ack)).toEqual({ ok: false });
    expect(nav.handle("alice", poll(nav.token))).toEqual({ command: null });
    nav.close();
  });

  test("times out without claiming the page was shown", async () => {
    const nav = new DeskVoiceNavigation("alice", 5);
    expect(await nav.show(target)).toEqual({
      shown: false,
      error: "The voice window did not confirm navigation.",
    });
    expect(nav.handle("alice", poll(nav.token))).toEqual({ command: null });
    nav.close();
  });

  test("HTTP rejects claimed users, malformed messages and unknown calls", async () => {
    async function request(body: unknown, login?: string) {
      const url = new URL("http://localhost/api/desk/voice/live/navigation");
      return handleDeskVoiceRoutes({
        req: new Request(url, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
        url,
        path: url.pathname,
        publicPrefix: "",
        authUser: login ? { login, name: "Same Name" } : null,
      });
    }
    expect(
      (await request({ ...poll(crypto.randomUUID()), user: "Alice" }))?.status,
    ).toBe(401);
    expect(
      (await request({ ...poll(crypto.randomUUID()), user: "Alice" }, "alice"))
        ?.status,
    ).toBe(400);
    const missing = await request(poll(crypto.randomUUID()), "alice");
    expect(missing?.status).toBe(404);
    expect(missing?.headers.get("Cache-Control")).toBe("no-store");
    expect(
      deskNavigationRequestSchema.safeParse({
        ...poll(crypto.randomUUID()),
        action: "ack",
        path: "/settings",
      }).success,
    ).toBe(false);
  });
});
