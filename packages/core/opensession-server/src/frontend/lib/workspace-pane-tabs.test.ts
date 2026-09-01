import { describe, expect, test } from "bun:test";
import type { Workspace } from "./types";
import {
  buildWorkspacePaneTabs,
  sessionlessWorkspacePanes,
  viewTabKind,
} from "./workspace-pane-tabs";

const NONE = new Set<string>();

function build(
  overrides: Partial<Parameters<typeof buildWorkspacePaneTabs>[0]> = {},
) {
  return buildWorkspacePaneTabs({
    workspaceKey: "workspace-1",
    sessionId: "session-1",
    activeViewTab: null,
    reviewCapable: false,
    reviewIsDefault: false,
    reviewOpen: NONE,
    reviewClosed: NONE,
    reviewDotClass: null,
    conversationThreadId: null,
    conversationClosed: NONE,
    videoLabel: null,
    videoClosed: NONE,
    stagingOpen: NONE,
    previewOpen: NONE,
    portalLabel: null,
    assetsOpen: NONE,
    terminalOpen: NONE,
    subagentLabel: null,
    ...overrides,
  });
}

describe("buildWorkspacePaneTabs", () => {
  test("builds workspace and session panes in stable order", () => {
    const open = new Set(["workspace-1"]);
    const tabs = build({
      activeViewTab: "conversation",
      reviewCapable: true,
      reviewIsDefault: true,
      reviewDotClass: "bg-green",
      conversationThreadId: "thread-1",
      videoLabel: "Video",
      stagingOpen: open,
      previewOpen: open,
      portalLabel: "Web app",
      assetsOpen: open,
      terminalOpen: open,
      subagentLabel: "Investigate",
    });

    expect(tabs.map(({ id }) => id)).toEqual([
      "review:workspace-1",
      "conversation:workspace-1",
      "video:workspace-1",
      "staging:workspace-1",
      "preview:workspace-1",
      "portal:workspace-1",
      "assets:workspace-1",
      "terminal:workspace-1",
      "subagent:session-1",
    ]);
    expect(tabs.find(({ active }) => active)?.id).toBe(
      "conversation:workspace-1",
    );
  });

  test("keeps only workspace-owned panes without a session", () => {
    const tabs = build({
      sessionId: undefined,
      reviewCapable: true,
      reviewOpen: new Set(["workspace-1"]),
      conversationThreadId: "thread-1",
      videoLabel: "Video",
      stagingOpen: new Set(["workspace-1"]),
    });

    expect(tabs.map(({ id }) => id)).toEqual([
      "review:workspace-1",
      "conversation:workspace-1",
      "video:workspace-1",
    ]);
  });

  test("honors explicit closes of default panes", () => {
    const closed = new Set(["workspace-1"]);
    expect(
      build({
        reviewCapable: true,
        reviewIsDefault: true,
        reviewClosed: closed,
        conversationThreadId: "thread-1",
        conversationClosed: closed,
        videoLabel: "Video",
        videoClosed: closed,
      }),
    ).toEqual([]);
  });
});

describe("sessionlessWorkspacePanes", () => {
  test("derives panes that survive the last session closing", () => {
    const workspace: Workspace = {
      id: "workspace-1",
      name: "PR work",
      createdBy: "Jaap",
      createdAt: "2026-08-18T10:00:00.000Z",
      prNumber: 42,
      plainThreadId: "thread-1",
      externalRefs: [{ kind: "video", id: "video-1" }],
    };
    expect(
      sessionlessWorkspacePanes("workspace-1", workspace, {
        reviewOpen: NONE,
        reviewClosed: NONE,
        conversationClosed: NONE,
        videoClosed: NONE,
        hasWebPanel: () => true,
      }),
    ).toEqual(["review", "conversation", "video"]);
  });
});

describe("viewTabKind", () => {
  test("maps tab ids and rejects session and home tabs", () => {
    expect(viewTabKind("review:workspace-1")).toBe("review");
    expect(viewTabKind("subagent:session-1")).toBe("subagent");
    expect(viewTabKind("session-1")).toBeNull();
    expect(viewTabKind("home:workspace-1")).toBeNull();
  });
});
