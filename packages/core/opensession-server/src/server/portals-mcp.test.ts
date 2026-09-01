import { afterEach, describe, expect, test } from "bun:test";
import { createMcpRuntime, type McpRuntime } from "./mcp-runtime";
import { createPortalsMcpServer } from "./portals-mcp";

const open: McpRuntime[] = [];

afterEach(async () => {
  for (const runtime of open.splice(0)) await runtime.close();
});

async function harness() {
  const calls: Array<{
    path: string | null;
    options?: {
      exclusiveKey?: string;
      sourceLeaseId?: string;
      leaseMinutes?: number;
    };
  }> = [];
  const server = createPortalsMcpServer({
    sessionId: "session-a",
    worktreeDir: () => "/tmp",
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
  return { calls, runtime };
}

describe("Portals MCP staging routes", () => {
  test("normalizes and reserves a server-proven Tella fixture", async () => {
    const { calls, runtime } = await harness();
    const fixtureExpiresAt = new Date(
      Date.now() + 120.5 * 60_000,
    ).toISOString();
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      {
        path: " /video/vid_fixture/edit?status=Subtitles ",
        videoId: "vid_fixture",
        fixtureLeaseId: "epfl_fixturelease",
        fixtureExpiresAt,
      },
      { toolCallId: "reserve" },
    );

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
      text: expect.stringContaining("epfl_fixturelease"),
    });
  });

  test("rejects self-reported or invented fixture evidence", async () => {
    const { calls, runtime } = await harness();
    await expect(
      runtime.callExact(
        "opensession-portals_set_editor_preview_path",
        {
          path: "/video/vid_fixture/edit",
          videoId: "vid_fixture",
          fixtureLeaseId: "local-fixture",
          fixtureExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
        { toolCallId: "invented" },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("rejects a reservation key for another video", async () => {
    const { calls, runtime } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      {
        path: "/video/vid_route/edit",
        videoId: "vid_other",
        fixtureLeaseId: "epfl_fixturelease",
        fixtureExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
      { toolCallId: "mismatch" },
    );

    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("must match the video ID"),
    });
  });

  test("rejects expired Tella fixture leases", async () => {
    const { calls, runtime } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      {
        path: "/video/vid_fixture/edit",
        videoId: "vid_fixture",
        fixtureLeaseId: "epfl_fixturelease",
        fixtureExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      { toolCallId: "expired" },
    );

    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("between 10 minutes and 7 days"),
    });
  });

  test("rejects malformed routes before persistence", async () => {
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

  test("keeps ordinary web routes outside the exclusive editor flow", async () => {
    const { calls, runtime } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_portal_path",
      { path: "/settings/tags" },
      { toolCallId: "ordinary" },
    );

    expect(calls).toEqual([{ path: "/settings/tags", options: undefined }]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("/settings/tags"),
    });
  });
});
