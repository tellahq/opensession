import { afterEach, describe, expect, test } from "bun:test";
import { createDesktopMcpServer, desktopScreenshotScale } from "./desktop-mcp";
import { createMcpRuntime, type McpRuntime } from "./mcp-runtime";
import type { SandboxDesktopControl } from "./sandbox/provider";

const open: McpRuntime[] = [];

afterEach(async () => {
  for (const runtime of open.splice(0)) await runtime.close();
});

function fakeControl(log: string[]): SandboxDesktopControl {
  return {
    async screenshot(options) {
      log.push(`screenshot ${JSON.stringify(options)}`);
      return {
        data: "aGVsbG8=",
        mimeType: "image/png",
        width: 1920,
        height: 1080,
      };
    },
    async display() {
      return { width: 1920, height: 1080 };
    },
    async windows() {
      return [
        {
          id: "1",
          title: "Chromium",
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          active: true,
        },
      ];
    },
    async move(x, y) {
      log.push(`move ${x},${y}`);
    },
    async click(x, y, options) {
      log.push(`click ${x},${y} ${JSON.stringify(options)}`);
    },
    async drag(from, to, options) {
      log.push(
        `drag ${from.x},${from.y}->${to.x},${to.y} ${JSON.stringify(options)}`,
      );
    },
    async scroll(x, y, direction, amount) {
      log.push(`scroll ${x},${y} ${direction} ${amount}`);
    },
    async type(text) {
      log.push(`type ${text}`);
    },
    async key(chord) {
      log.push(`key ${chord}`);
    },
  };
}

async function harness(control: SandboxDesktopControl | null) {
  const wakes: number[] = [];
  const server = createDesktopMcpServer({
    sessionId: "session-a",
    control: async () => {
      wakes.push(1);
      return control;
    },
  });
  const runtime = await createMcpRuntime({
    mcpServers: [],
    deniedToolIds: new Set(),
    inProcessMcp: { "opensession-desktop": server },
  });
  open.push(runtime);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    runtime.callExact(`opensession-desktop_${name}`, args, {
      toolCallId: name,
    });
  return { call, wakes };
}

describe("desktopScreenshotScale", () => {
  test("shrinks only desktops wider than the model-friendly bound", () => {
    expect(desktopScreenshotScale(1024, 768)).toBe(1);
    expect(desktopScreenshotScale(1920, 1080)).toBe(0.67);
    expect(desktopScreenshotScale(1080, 1920)).toBe(0.67);
    expect(desktopScreenshotScale(0, 0)).toBe(1);
  });
});

describe("desktop MCP", () => {
  test("screenshot returns the image plus the desktop size it maps to", async () => {
    const log: string[] = [];
    const { call } = await harness(fakeControl(log));
    const response = await call("screenshot");
    expect(log).toEqual(['screenshot {"scale":0.67,"format":"jpeg"}']);
    expect(response.content).toEqual([
      {
        type: "text",
        text: "Desktop 1920x1080, image scaled to 0.67 of that; give coordinates in desktop pixels.",
      },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
  });

  test("input tools forward to the control and describe what they did", async () => {
    const log: string[] = [];
    const { call, wakes } = await harness(fakeControl(log));
    await call("click", { x: 10, y: 20, button: "right", double: true });
    await call("type", { text: "hello" });
    await call("key", { chord: "ctrl+l" });
    await call("scroll", { x: 1, y: 2, direction: "down" });
    await call("drag", { fromX: 1, fromY: 2, toX: 3, toY: 4 });
    const windows = await call("windows");
    expect(log).toEqual([
      'click 10,20 {"button":"right","double":true}',
      "type hello",
      "key ctrl+l",
      "scroll 1,2 down undefined",
      "drag 1,2->3,4 {}",
    ]);
    expect(windows.content[0]).toEqual({
      type: "text",
      text: "Desktop 1920x1080. 1 visible window:\n* Chromium at (0, 0) 1920x1080",
    });
    // Every call resolves the control fresh, which is what wakes a sleeping
    // Sandbox instead of holding a stale handle.
    expect(wakes.length).toBe(6);
  });

  test("a session without a desktop gets a plain explanation", async () => {
    const { call } = await harness(null);
    const response = await call("click", { x: 1, y: 1 });
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("no Sandbox desktop"),
    });
  });
});
