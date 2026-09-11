import { describe, expect, test } from "bun:test";
import { DeskNavigationClient } from "./desk-navigation-client";
import { DeskVoiceNavigation } from "../../server/desk-voice-navigation";
import type { DeskNavigationRequest } from "../../shared/desk-navigation";

const target = { kind: "workspace", id: "ws-1" } as const;

describe("voice browser navigation", () => {
  test("round trips a real command and acknowledgment without another tab following", async () => {
    const server = new DeskVoiceNavigation("alice");
    const shown: unknown[] = [];
    const request = async (body: DeskNavigationRequest) =>
      Response.json(server.handle("alice", body));
    const owner = new DeskNavigationClient(
      "call",
      server.token,
      (route) => {
        shown.push(route);
        return true;
      },
      request,
    );
    const otherTab = new DeskNavigationClient(
      "call",
      crypto.randomUUID(),
      () => {
        throw new Error("Wrong tab navigated");
      },
      request,
    );
    const result = server.show(target);
    await expect(otherTab.poll()).rejects.toThrow();
    await owner.poll();
    expect(await result).toEqual({ shown: true });
    expect(shown).toEqual([target]);
    await owner.poll();
    expect(shown).toHaveLength(1);
    owner.stop();
    otherTab.stop();
    server.close();
  });

  test("does not navigate if hangup happens while a response is in flight", async () => {
    let deliver: (value: Response) => void = () => {};
    const response = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    let navigated = false;
    const client = new DeskNavigationClient(
      "call",
      crypto.randomUUID(),
      () => {
        navigated = true;
        return true;
      },
      async () => response,
    );
    const pending = client.poll();
    client.stop();
    deliver(
      Response.json({
        command: {
          id: crypto.randomUUID(),
          target,
          expiresAt: Date.now() + 10_000,
        },
      }),
    );
    await pending;
    expect(navigated).toBe(false);
  });

  test("duplicate delivery reuses the acknowledgment without navigating twice", async () => {
    const command = {
      id: crypto.randomUUID(),
      target,
      expiresAt: Date.now() + 10_000,
    };
    let navigated = 0;
    const acks: unknown[] = [];
    const client = new DeskNavigationClient(
      "call",
      crypto.randomUUID(),
      () => {
        navigated++;
        return true;
      },
      async (body) => {
        if (body.action === "poll") return Response.json({ command });
        acks.push(body);
        return Response.json({ ok: true });
      },
    );
    await client.poll();
    await client.poll();
    expect(navigated).toBe(1);
    expect(acks).toHaveLength(2);
    client.stop();
  });

  test("expired, malformed and arbitrary route commands never navigate", async () => {
    let navigated = false;
    for (const command of [
      { id: crypto.randomUUID(), target, expiresAt: 0 },
      {
        id: crypto.randomUUID(),
        target: { kind: "settings", id: "account" },
        expiresAt: Date.now() + 10_000,
      },
      {
        id: crypto.randomUUID(),
        target: { kind: "session", id: "../settings" },
        expiresAt: Date.now() + 10_000,
      },
    ]) {
      const client = new DeskNavigationClient(
        "call",
        crypto.randomUUID(),
        () => {
          navigated = true;
          return true;
        },
        async () => Response.json({ command }),
      );
      await client.poll().catch(() => {});
      client.stop();
    }
    expect(navigated).toBe(false);
  });

  test("a missing app handler is reported as failure", async () => {
    const server = new DeskVoiceNavigation("alice");
    const client = new DeskNavigationClient(
      "call",
      server.token,
      () => false,
      async (body) => Response.json(server.handle("alice", body)),
    );
    const result = server.show(target);
    await client.poll();
    expect(await result).toMatchObject({ shown: false });
    client.stop();
    server.close();
  });
});
