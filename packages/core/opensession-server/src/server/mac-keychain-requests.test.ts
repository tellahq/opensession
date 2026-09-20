import { describe, expect, test } from "bun:test";
import {
  MacKeychainRequests,
  macKeychainRequestSchema,
} from "./mac-keychain-requests";

const intent = {
  account: "demo@example.test",
  service: "Example API",
  purpose: "Check service authentication",
  url: "https://api.example.com/me",
  method: "GET",
  injection: "bearer",
};

describe("single-item macOS Keychain requests", () => {
  test("requires one exact service and account, never a list or raw value", () => {
    for (const input of [
      { ...intent, service: "" },
      { ...intent, account: "" },
      { ...intent, service: ["first", "second"] },
      { ...intent, account: "invalid\nname" },
      { ...intent, service: "spoof\u202ename" },
      { ...intent, secret: "NEVER" },
      { ...intent, reference: "op://Work/API/token" },
    ])
      expect(macKeychainRequestSchema.safeParse(input).success).toBe(false);
    expect(macKeychainRequestSchema.safeParse(intent).success).toBe(true);
    expect(
      macKeychainRequestSchema.safeParse({
        ...intent,
        service: "Unicode café",
        account: "--literal-not-a-flag",
      }).success,
    ).toBe(true);
  });

  test("rejects unsafe intent before asking", () => {
    for (const url of [
      "not-a-url",
      "http://api.example.com",
      "https://u:p@api.example.com",
      "https://api.example.com:123/a",
      "https://api.example.com/#fragment",
    ]) {
      expect(
        macKeychainRequestSchema.safeParse({ ...intent, url }).success,
      ).toBe(false);
    }
    for (const extra of [
      { account: "invalid\0suffix" },
      { method: "CONNECT" },
      { body: "x" },
      { injection: "cookie" },
      { purpose: "trusted\u202eevil" },
    ]) {
      expect(
        macKeychainRequestSchema.safeParse({ ...intent, ...extra }).success,
      ).toBe(false);
    }
  });

  test("binds metadata, claims and results to the session and verified login", () => {
    const requests = new MacKeychainRequests();
    const r = requests.request("session-a", "Alice", intent);
    expect(requests.status(r.id, "session-b", "alice")).toBeNull();
    expect(requests.status(r.id, "session-a", "bob")).toBeNull();
    expect(requests.pending("session-a", "bob")).toBeNull();
    expect(requests.claim(r.id, "bob")).toBeNull();
    const pending = requests.pending("session-a", "alice")!;
    pending.intent.url = "https://wrong.example.com";
    expect(requests.pending("session-a", "alice")!.intent.url).toBe(intent.url);
    const claim = requests.claim(r.id, "alice")!;
    expect(requests.claim(r.id, "alice")).toBeNull();
    expect(
      requests.finish(r.id, "bob", claim.claim, {
        status: "completed",
        httpStatus: 200,
      }),
    ).toBe(false);
    expect(
      requests.finish(r.id, "alice", "wrong", {
        status: "completed",
        httpStatus: 200,
      }),
    ).toBe(false);
    expect(
      requests.finish(r.id, "alice", claim.claim, {
        status: "completed",
        httpStatus: 200,
      }),
    ).toBe(true);
    expect(
      requests.finish(r.id, "alice", claim.claim, {
        status: "completed",
        httpStatus: 200,
      }),
    ).toBe(false);
    expect(requests.status(r.id, "session-a", "alice")).toEqual({
      id: r.id,
      status: "completed",
      httpStatus: 200,
      expiresAt: r.expiresAt,
    });
  });

  test("rejects all free-form output and never projects a claim into model results", () => {
    const requests = new MacKeychainRequests();
    const r = requests.request("session", "alice", intent);
    const { claim } = requests.claim(r.id, "alice")!;
    for (const outcome of [
      { status: "completed", httpStatus: 200, body: "SECRET" },
      { status: "completed", httpStatus: 200, headers: { secret: "SECRET" } },
      { status: "failed", error: "SECRET" },
      { status: "SECRET" },
      { status: "completed", httpStatus: "SECRET" },
    ])
      expect(requests.finish(r.id, "alice", claim, outcome)).toBe(false);
    expect(
      JSON.stringify(requests.status(r.id, "session", "alice")),
    ).not.toContain(claim);
    expect(requests.finish(r.id, "alice", claim, { status: "failed" })).toBe(
      true,
    );
    expect(requests.claim(r.id, "alice")).toBeNull();
  });

  test("expires, bounds pending asks, and loses all authority on restart", () => {
    let now = 1000;
    const requests = new MacKeychainRequests(() => now);
    const r = requests.request("session", "alice", intent);
    expect(() => requests.request("session", "alice", intent)).toThrow();
    now += 10 * 60_000;
    expect(requests.claim(r.id, "alice")).toBeNull();
    expect(requests.status(r.id, "session", "alice")).toBeNull();
    requests.request("session", "alice", intent);
    expect(new MacKeychainRequests().pending("session", "alice")).toBeNull();
  });
});
