import { afterEach, describe, expect, test } from "bun:test";
import { createMcpRuntime, type McpRuntime } from "./mcp-runtime";
import { createPortalsMcpServer, type PortalsMcpContext } from "./portals-mcp";

const open: McpRuntime[] = [];

afterEach(async () => {
  for (const runtime of open.splice(0)) await runtime.close();
});

type VerifiedFixture = Awaited<
  ReturnType<PortalsMcpContext["verifyEditorFixture"]>
>;

function fixture(overrides: Partial<VerifiedFixture> = {}): VerifiedFixture {
  return {
    leaseId: "epfl_fixturelease",
    videoId: "vid_fixture",
    editorPath: "/video/vid_fixture/edit?status=Subtitles",
    expiresAt: new Date(Date.now() + 120.5 * 60_000).toISOString(),
    editorAccessVerified: true,
    ...overrides,
  };
}

async function harness(
  verifyEditorFixture: PortalsMcpContext["verifyEditorFixture"] = async () =>
    fixture(),
) {
  const calls: Array<{
    path: string | null;
    options?: {
      exclusiveKey?: string;
      sourceLeaseId?: string;
      leaseMinutes?: number;
    };
  }> = [];
  const verificationCalls: string[] = [];
  const server = createPortalsMcpServer({
    sessionId: "session-a",
    worktreeDir: () => "/tmp",
    verifyEditorFixture: async (leaseId) => {
      verificationCalls.push(leaseId);
      return verifyEditorFixture(leaseId);
    },
    setDefaultPath: async (path, options) => {
      calls.push({ path, options });
      return options?.exclusiveKey ? { leaseId: "lease-a" } : {};
    },
    sandbox: async () => null,
    hasSandbox: () => false,
    runner: () => undefined,
  });
  const runtime = await createMcpRuntime({
    mcpServers: [],
    deniedToolIds: new Set(),
    inProcessMcp: { "opensession-portals": server },
  });
  open.push(runtime);
  return { calls, runtime, verificationCalls };
}

describe("Portals MCP staging routes", () => {
  test("uses Tella's authoritative fixture fields", async () => {
    const { calls, runtime, verificationCalls } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      { fixtureLeaseId: "epfl_fixturelease" },
      { toolCallId: "reserve" },
    );

    expect(verificationCalls).toEqual(["epfl_fixturelease"]);
    expect(calls).toEqual([
      {
        path: "/video/vid_fixture/edit?status=Subtitles",
        options: {
          exclusiveKey: "video:vid_fixture",
          sourceLeaseId: "epfl_fixturelease",
          leaseMinutes: 120,
        },
      },
    ]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Verified and reserved"),
    });
  });

  test("rejects an invented lease that Tella does not recognize", async () => {
    const { calls, runtime } = await harness(async () => {
      throw new Error("The editor preview fixture lease is not active");
    });
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      { fixtureLeaseId: "epfl_invented" },
      { toolCallId: "invented" },
    );

    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("not active"),
    });
  });

  test("rejects a different lease returned by Tella", async () => {
    const { calls, runtime } = await harness(async () =>
      fixture({ leaseId: "epfl_otherlease" }),
    );
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      { fixtureLeaseId: "epfl_fixturelease" },
      { toolCallId: "lease-mismatch" },
    );

    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("different fixture lease"),
    });
  });

  test("rejects a Tella route for another video", async () => {
    const { calls, runtime } = await harness(async () =>
      fixture({ editorPath: "/video/vid_other/edit" }),
    );
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      { fixtureLeaseId: "epfl_fixturelease" },
      { toolCallId: "video-mismatch" },
    );

    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("does not match"),
    });
  });

  test("rejects a non-editor route that merely contains the video ID", async () => {
    const { calls, runtime } = await harness(async () =>
      fixture({ editorPath: "/settings/vid_fixture" }),
    );
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      { fixtureLeaseId: "epfl_fixturelease" },
      { toolCallId: "route-shape" },
    );

    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("does not match"),
    });
  });

  test("rejects an expired Tella lease", async () => {
    const { calls, runtime } = await harness(async () =>
      fixture({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      { fixtureLeaseId: "epfl_fixturelease" },
      { toolCallId: "expired" },
    );

    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("between 10 minutes and 7 days"),
    });
  });

  test("rejects malformed ordinary routes before persistence", async () => {
    const { calls, runtime } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_portal_path",
      { path: "https://example.com/video" },
      { toolCallId: "invalid" },
    );

    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("root-relative"),
    });
  });

  test("rejects Tella editor routes through the generic setter", async () => {
    const { calls, runtime, verificationCalls } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_portal_path",
      { path: "/video/vid_invented/edit?status=Subtitles" },
      { toolCallId: "generic-editor" },
    );

    expect(verificationCalls).toEqual([]);
    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("set_editor_preview_path"),
    });
  });

  test("rejects generic routes that canonicalize to a Tella editor", async () => {
    const { calls, runtime, verificationCalls } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_portal_path",
      { path: "/other/../video/vid_invented/edit" },
      { toolCallId: "canonical-editor" },
    );

    expect(verificationCalls).toEqual([]);
    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("set_editor_preview_path"),
    });
  });

  test("keeps ordinary web routes outside the exclusive editor flow", async () => {
    const { calls, runtime, verificationCalls } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_portal_path",
      { path: "/settings/tags" },
      { toolCallId: "ordinary" },
    );

    expect(verificationCalls).toEqual([]);
    expect(calls).toEqual([{ path: "/settings/tags", options: undefined }]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("/settings/tags"),
    });
  });
});
