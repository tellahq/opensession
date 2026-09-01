// authGatesOut is the single predicate UserGate and useWebSocket share to
// decide "the instance now requires sign-in and this browser has no accepted
// session" — the state where every authenticated route and the UI WebSocket
// upgrade 401. UserGate renders the sign-in card on it; useWebSocket stops
// presenting the refused upgrade as a reconnect overlay. If the two ever
// disagreed, a gated browser would sit forever on "Connection lost. retrying"
// with no way to sign in — the lockout this pins shut.

import { describe, expect, test } from "bun:test";
import { authGatesOut } from "./auth-ready";

describe("authGatesOut", () => {
  test("gated: sign-in required and this browser is not authenticated", () => {
    expect(authGatesOut({ required: true, authenticated: false })).toBe(true);
  });

  test("not gated: signed in", () => {
    expect(authGatesOut({ required: true, authenticated: true })).toBe(false);
  });

  test("not gated: instance does not require sign-in", () => {
    expect(authGatesOut({ required: false, authenticated: false })).toBe(false);
  });

  test("unknown status (null/undefined) is never a lockout", () => {
    expect(authGatesOut(null)).toBe(false);
    expect(authGatesOut(undefined)).toBe(false);
  });
});
