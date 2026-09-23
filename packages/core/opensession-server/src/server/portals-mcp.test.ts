import { afterEach, describe, expect, test } from "bun:test";
import { createMcpRuntime, type McpRuntime } from "./mcp-runtime";
import {
  createPortalsMcpServer,
  type PortalsMcpContext,
  settleBefore,
  settleWithin,
} from "./portals-mcp";

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
  overrides: Partial<PortalsMcpContext> = {},
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
    ...overrides,
  });
  const runtime = await createMcpRuntime({
    mcpServers: [],
    deniedToolIds: new Set(),
    inProcessMcp: { "opensession-portals": server },
  });
  open.push(runtime);
  return { calls, runtime, verificationCalls };
}

describe("settleWithin", () => {
  test("returns the value of a start that finishes in time", async () => {
    expect(await settleWithin(Promise.resolve("ready"), 1_000)).toEqual({
      settled: true,
      value: "ready",
    });
  });

  test("answers pending for a start still booting, without dropping it", async () => {
    let finish = () => {};
    const slow = new Promise<string>((resolve) => {
      finish = () => resolve("late");
    });
    expect(await settleWithin(slow, 10)).toEqual({ settled: false });
    finish();
    expect(await slow).toBe("late");
  });

  test("a start that fails in time rejects like the start itself", async () => {
    await expect(
      settleWithin(Promise.reject(new Error("port taken")), 1_000),
    ).rejects.toThrow("port taken");
  });
});

describe("settleBefore", () => {
  test("answers pending at once when earlier steps spent the whole budget", async () => {
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("late"), 5_000),
    );
    const started = Date.now();
    expect(await settleBefore(slow, Date.now() - 1)).toEqual({
      settled: false,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("still returns a value that is already there", async () => {
    expect(
      await settleBefore(Promise.resolve("ready"), Date.now() - 1),
    ).toEqual({ settled: true, value: "ready" });
  });
});

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

function text(response: { content: unknown[] }): string {
  const first = response.content[0] as { text?: string } | undefined;
  return first?.text ?? "";
}

describe("Portals MCP Sandbox readiness", () => {
  test("a start whose Sandbox is still coming up answers before the deadline and keeps the start alive", async () => {
    let wakes = 0;
    let release!: () => void;
    const machine = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const { runtime } = await harness(undefined, {
      hasSandbox: () => true,
      waitMs: 50,
      sandbox: async (options) => {
        if (!options?.wake) return null;
        wakes++;
        return machine;
      },
      sandboxState: () => ({
        where: "portal",
        provider: "box",
        lifecycle: "preparing",
        materialized: false,
        busy: true,
      }),
    });
    const started = Date.now();
    const response = await runtime.callExact(
      "opensession-portals_start_declared_portal",
      { id: "web" },
      { toolCallId: "start-preparing" },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(text(response)).toContain("still being prepared");
    expect(text(response)).toContain("web starts there as soon as it is up");
    expect(text(response)).toContain("Do not start it again");
    expect(wakes).toBe(1);
    release();
  });

  test("a machine recorded and waking is reported as waking", async () => {
    const { runtime } = await harness(undefined, {
      hasSandbox: () => true,
      waitMs: 50,
      sandbox: () => new Promise<null>(() => {}),
      sandboxState: () => ({
        where: "portal",
        provider: "box",
        lifecycle: "waking",
        materialized: true,
        busy: true,
      }),
    });
    const response = await runtime.callExact(
      "opensession-portals_restart_portal",
      { name: "web" },
      { toolCallId: "restart-waking" },
    );
    expect(text(response)).toContain("still waking; web starts there");
  });

  test("no live Sandbox reads as what the machine is doing, with the recorded error", async () => {
    const state: NonNullable<
      ReturnType<NonNullable<PortalsMcpContext["sandboxState"]>>
    > & {
      where: "portal";
    } = {
      where: "portal",
      provider: "box",
      lifecycle: "needs_attention",
      materialized: false,
      error: "box API POST /sandboxes timed out after 60s",
      busy: false,
    };
    const { runtime } = await harness(undefined, {
      hasSandbox: () => true,
      sandbox: async () => null,
      sandboxState: () => state,
    });
    const list = () =>
      runtime.callExact(
        "opensession-portals_list_portals",
        {},
        { toolCallId: `list-${state.lifecycle}-${state.busy}` },
      );
    expect(text(await list())).toBe(
      "The Portal Sandbox (box) that runs this session's Portals needs attention: box API POST /sandboxes timed out after 60s. Starting a Portal tries again.",
    );
    const start = await runtime.callExact(
      "opensession-portals_start_portal",
      { name: "web", command: "bun dev" },
      { toolCallId: "start-needs-attention" },
    );
    expect(text(start)).toBe(
      "Could not start Portal: the Portal Sandbox (box) that runs this session's Portals needs attention: box API POST /sandboxes timed out after 60s. Starting a Portal tries again.",
    );

    state.busy = true;
    expect(text(await list())).toContain("is still being prepared");
    state.materialized = true;
    expect(text(await list())).toContain("is still waking");

    state.busy = false;
    state.lifecycle = "sleeping";
    delete state.error;
    expect(text(await list())).toContain(
      "is asleep. Starting or restarting a Portal wakes it.",
    );
    expect(text(await list())).not.toContain("sending a message");

    state.lifecycle = "none";
    state.materialized = false;
    expect(text(await list())).toContain(
      "is created by the first start_portal or start_declared_portal",
    );
  });
});

describe("Simulator Portal MCP", () => {
  test("storage clearing requires explicit true confirmation before resolving a workspace", async () => {
    let consultedWorkspace = false;
    const { runtime } = await harness(undefined, {
      worktreeDir: () => {
        consultedWorkspace = true;
        return undefined;
      },
    });
    for (const args of [{}, { confirm: false }, { confirm: "true" }]) {
      await expect(
        runtime.callExact("opensession-portals_clear_simulator_storage", args, {
          toolCallId: "clear-unconfirmed",
        }),
      ).rejects.toThrow("confirm");
      expect(consultedWorkspace).toBe(false);
    }
  });

  test("storage clearing refuses missing and remote workspaces without waking them", async () => {
    let woke = false;
    const contexts: Array<Partial<PortalsMcpContext>> = [
      { worktreeDir: () => undefined },
      { hasSandbox: () => true },
      {
        runner: () => ({
          id: "runner-session",
          source: "opensession",
          claudeSessionId: null,
          branch: "main",
          worktreeDir: "/workspace",
          startedBy: null,
          title: "Runner",
          lastActivity: "",
          createdAt: "",
          isRunning: false,
          transcriptPath: null,
          runner: {
            id: "runner-1",
            name: "Test runner",
            workspacePath: "/workspace",
          },
        }),
      },
    ];
    for (const context of contexts) {
      const { runtime } = await harness(undefined, {
        sandbox: async () => {
          woke = true;
          return null;
        },
        ...context,
      });
      const response = await runtime.callExact(
        "opensession-portals_clear_simulator_storage",
        { confirm: true },
        { toolCallId: "clear-wrong-workspace" },
      );
      expect(response.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("workspace"),
      });
      expect(woke).toBe(false);
    }
  });
  test("the tool is discoverable and refuses Sandbox workspaces without waking them", async () => {
    let woke = false;
    const { runtime } = await harness(undefined, {
      hasSandbox: () => true,
      sandbox: async () => {
        woke = true;
        return null;
      },
    });
    const response = await runtime.callExact(
      "opensession-portals_start_simulator_portal",
      { appPath: "Build/App.app" },
      { toolCallId: "simulator" },
    );
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("local Mac workspace"),
    });
    expect(woke).toBe(false);
  });

  test("no workspace cannot create a simulator on the host", async () => {
    const { runtime } = await harness(undefined, {
      worktreeDir: () => undefined,
    });
    const response = await runtime.callExact(
      "opensession-portals_start_simulator_portal",
      { appPath: "App.app" },
      { toolCallId: "simulator-no-workspace" },
    );
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("no workspace"),
    });
  });
});
