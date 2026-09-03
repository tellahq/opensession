import { describe, expect, test } from "bun:test";
import {
  errorMatchesPendingCreate,
  shouldApplyCreatedSessionReply,
  shouldOpenCreatedSession,
} from "./new-session-navigation";

const appSource = await Bun.file(
  new URL("../AppContent.tsx", import.meta.url),
).text();
const createStartSource = await Bun.file(
  new URL("../hooks/useNewSessionCreateStart.ts", import.meta.url),
).text();

describe("errorMatchesPendingCreate", () => {
  test("only accepts an error scoped to the deterministic create id", () => {
    expect(errorMatchesPendingCreate("os-new", "os-new")).toBe(true);
    expect(errorMatchesPendingCreate(undefined, "os-new")).toBe(false);
    expect(errorMatchesPendingCreate("os-watched", "os-new")).toBe(false);
  });
});

describe("shouldApplyCreatedSessionReply", () => {
  test("drops a durable create replay after its pending draft is gone", () => {
    expect(shouldApplyCreatedSessionReply(true, false)).toBe(false);
  });

  test("keeps an ordinary reply and a reconnect reply for a pending create", () => {
    expect(shouldApplyCreatedSessionReply(undefined, false)).toBe(true);
    expect(shouldApplyCreatedSessionReply(true, true)).toBe(true);
  });

  test("guards the optimistic session injection in App", () => {
    expect(appSource).toContain(
      "if (!shouldApplyCreatedSessionReply(msg.replayed, !!draft))",
    );
  });
});

describe("shouldOpenCreatedSession", () => {
  test("does not let a replayed creator reply take the foreground", () => {
    expect(shouldOpenCreatedSession(null, "/session/current", false)).toBe(
      false,
    );
  });

  test("does not navigate for a restart-recovery room announcement", () => {
    expect(
      shouldOpenCreatedSession(null, "/session/current", false, true),
    ).toBe(false);
  });

  test("opens a palette create while its origin still owns the foreground", () => {
    expect(
      shouldOpenCreatedSession(
        { originPath: "/session/one" },
        "/session/one",
        true,
      ),
    ).toBe(true);
  });

  test("leaves the current view alone for a background create", () => {
    expect(
      shouldOpenCreatedSession(
        { originPath: "/session/one", background: true },
        "/session/one",
        true,
      ),
    ).toBe(false);
  });

  test("does not hijack a newer route or a dismissed palette", () => {
    expect(
      shouldOpenCreatedSession(
        { originPath: "/session/one" },
        "/settings",
        true,
      ),
    ).toBe(false);
    expect(
      shouldOpenCreatedSession(
        { originPath: "/session/one" },
        "/session/one",
        false,
      ),
    ).toBe(false);
  });

  test("opens a deterministic local shell before the server responds", () => {
    const start = createStartSource.indexOf("const startNewSessionCreate");
    const end = createStartSource.indexOf(
      "return { closePalette, startNewSessionCreate }",
      start,
    );
    const handler = createStartSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain("if (!started.openImmediately) return;");
    expect(handler).toContain("inject(shell, { sticky: true })");
    const immediateCreate = handler.slice(
      handler.indexOf("flushSync(() =>"),
      handler.indexOf("if (!started.openImmediately) return;"),
    );
    expect(immediateCreate).toContain("hidePalette()");
    expect(immediateCreate).not.toContain("closePalette()");
    expect(handler).toContain("setActiveViewTabState(null)");
    expect(handler).toContain("saveActiveViewTab(started.workspaceId, null)");
    expect(handler).toContain('navigate({ view: "session", id: started.id })');
    expect(handler.indexOf("inject(shell")).toBeLessThan(
      handler.indexOf("navigate("),
    );
    expect(handler.indexOf("setActiveViewTabState(null)")).toBeLessThan(
      handler.indexOf('navigate({ view: "session", id: started.id })'),
    );
    expect(handler).not.toContain("setTimeout(");
  });
});
