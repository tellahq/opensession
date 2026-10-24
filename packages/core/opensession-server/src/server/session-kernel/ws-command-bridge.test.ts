import { describe, expect, test } from "bun:test";
import {
  isInternalKernelDispatch,
  recordInternalKernelResult,
} from "./ws-command-bridge";

describe("recursive WebSocket command token", () => {
  test("membership checks do not retire the token before failure is consumed", () => {
    const active = new Set(["command-one"]);
    expect(isInternalKernelDispatch(active, "command-one")).toBe(true);
    expect(isInternalKernelDispatch(active, "command-one")).toBe(true);
    expect(active.has("command-one")).toBe(true);
    active.delete("command-one");
    expect(isInternalKernelDispatch(active, "command-one")).toBe(false);
  });

  test("rejects unrelated and malformed tokens", () => {
    const active = new Set(["owned"]);
    expect(isInternalKernelDispatch(active, "foreign")).toBe(false);
    expect(isInternalKernelDispatch(active, null)).toBe(false);
  });
});

describe("recordInternalKernelResult", () => {
  test("stores results only for tokens the outer dispatch owns", () => {
    const active = new Set(["owned"]);
    const results = new Map<string, unknown>();
    recordInternalKernelResult(active, results, "owned", { ok: true });
    // A client can put any token on its own message; nothing would ever
    // delete an entry stored under it.
    for (let i = 0; i < 100; i++)
      recordInternalKernelResult(active, results, `foreign-${i}`, { ok: true });
    recordInternalKernelResult(active, results, 42, { ok: true });
    expect([...results.keys()]).toEqual(["owned"]);
  });
});
