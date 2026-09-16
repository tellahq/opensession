import { publishClientDataIdentity } from "./client-data-scope";
beforeEach(() =>
  publishClientDataIdentity({ required: false, authenticated: false }),
);
afterEach(() => publishClientDataIdentity(null));
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  forgetParkedNewSessionWorkspace,
  getParkedNewSessionWorkspaceId,
  rememberParkedNewSessionWorkspace,
} from "./new-session-workspace-draft";

const appSource = await Bun.file(
  new URL("../AppContent.tsx", import.meta.url),
).text();
const helperSource = await Bun.file(
  new URL("./new-session-workspace-draft.ts", import.meta.url),
).text();

describe("parked new-session workspace", () => {
  test("an older async cleanup cannot release a newer parked workspace", () => {
    rememberParkedNewSessionWorkspace("ws-old");
    rememberParkedNewSessionWorkspace("ws-new");

    forgetParkedNewSessionWorkspace("ws-old");
    expect(getParkedNewSessionWorkspaceId()).toBe("ws-new");

    forgetParkedNewSessionWorkspace("ws-new");
    expect(getParkedNewSessionWorkspaceId()).toBeNull();
  });

  test("a successful create consumes the parked workspace and its local draft", () => {
    expect(helperSource).toContain("dropStagingAttachments(draftKey)");
    expect(helperSource).toContain("clearDraft(draftKey)");
    expect(helperSource).toContain(
      "forgetParkedNewSessionWorkspace(id, scope)",
    );
  });

  test("App consumes the parked workspace after an optimistic palette unmount", () => {
    const start = appSource.indexOf('if (msg.type === "session_created")');
    const end = appSource.indexOf("const openedOptimistically", start);
    const createdHandler = appSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(createdHandler).toContain("consumeNewSessionWorkspaceDraft(");
  });
});

test("same-text parked operations cannot be consumed across owners or auth lifetimes", async () => {
  const { captureClientDataScope } = await import("./client-data-scope");
  const { pendingDraftParks, consumePendingDraftParks, draftParkInFlight } =
    await import("./new-session-workspace-draft");
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 11,
  });
  const scope = captureClientDataScope();
  const operation = {
    scope,
    text: "same text",
    workspaceId: "shared",
    consumed: false,
  };
  pendingDraftParks.add(operation);
  try {
    rememberParkedNewSessionWorkspace("A-workspace", scope);
    publishClientDataIdentity({
      required: true,
      authenticated: true,
      githubAccountId: 12,
    });
    expect(getParkedNewSessionWorkspaceId()).toBeNull();
    expect(draftParkInFlight("same text", "shared")).toBe(false);
    consumePendingDraftParks("same text", "shared", "B-workspace");
    consumePendingDraftParks("same text", "shared", "stale-A", scope);
    expect(operation.consumed).toBe(false);
    publishClientDataIdentity({
      required: true,
      authenticated: true,
      githubAccountId: 11,
    });
    expect(draftParkInFlight("same text", "shared")).toBe(false);
    expect(getParkedNewSessionWorkspaceId()).toBeNull();
  } finally {
    pendingDraftParks.delete(operation);
  }
});
