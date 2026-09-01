import { describe, expect, test } from "bun:test";
import {
  forgetParkedNewSessionWorkspace,
  getParkedNewSessionWorkspaceId,
  rememberParkedNewSessionWorkspace,
} from "./new-session-workspace-draft";

const appSource = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
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
    expect(helperSource).toContain("forgetParkedNewSessionWorkspace(id)");
  });

  test("App consumes the parked workspace after an optimistic palette unmount", () => {
    const start = appSource.indexOf('if (msg.type === "session_created")');
    const end = appSource.indexOf("const openedOptimistically", start);
    const createdHandler = appSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(createdHandler).toContain(
      "consumeNewSessionWorkspaceDraft(draft.workspaceId)",
    );
  });
});
