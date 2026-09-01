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
    options?: { exclusiveKey?: string; leaseMinutes?: number };
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
  test("normalizes and reserves a proven editor staging record", async () => {
    const { calls, runtime } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_editor_preview_path",
      {
        path: " /video/vid_fixture/edit?status=Subtitles ",
        exclusiveKey: "video:vid_fixture",
        durationSeconds: 90,
        clipCount: 3,
        transcriptWordCount: 240,
        leaseMinutes: 120,
      },
      { toolCallId: "reserve" },
    );

    expect(calls).toEqual([
      {
        path: "/video/vid_fixture/edit?status=Subtitles",
        options: {
          exclusiveKey: "video:vid_fixture",
          leaseMinutes: 120,
        },
      },
    ]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("90s, 3 clips, 240 transcript words"),
    });
  });

  test("rejects editor records without the required content", async () => {
    const { calls, runtime } = await harness();
    await expect(
      runtime.callExact(
        "opensession-portals_set_editor_preview_path",
        {
          path: "/video/vid_fixture/edit",
          exclusiveKey: "video:vid_fixture",
          durationSeconds: 20,
          clipCount: 1,
          transcriptWordCount: 0,
        },
        { toolCallId: "too-small" },
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
        exclusiveKey: "video:vid_other",
        durationSeconds: 90,
        clipCount: 2,
        transcriptWordCount: 100,
      },
      { toolCallId: "mismatch" },
    );

    expect(calls).toEqual([]);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("must match the video ID"),
    });
  });

  test("rejects malformed routes before persistence", async () => {
    const { calls, runtime } = await harness();
    const response = await runtime.callExact(
      "opensession-portals_set_portal_path",
      { path: "https://example.com/video", exclusiveKey: "video:fixture" },
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
