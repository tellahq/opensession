import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createRunnerPairing,
  listRunners,
  registerRunner,
  removeRunner,
} from "./runners";
import { runnerWsClose, runnerWsMessage, runnerWsOpen } from "./runner-ws";
import {
  vmDisplayClose,
  vmDisplayMessage,
  vmDisplayOpen,
  vmDisplayStreamPath,
  vmDisplayViewerCount,
} from "./vm-display";

const HOME = mkdtempSync(join(tmpdir(), "os-vm-display-test-"));
const realHome = process.env.HOME;
process.env.HOME = HOME;

afterEach(() => {
  for (const runner of listRunners()) removeRunner(runner.id);
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(HOME, { recursive: true, force: true });
});

function connectedRunner(name = "mac-mini", address = "100.101.102.103") {
  const { code } = createRunnerPairing("tester");
  const registered = registerRunner({
    code,
    name,
    platform: "darwin",
    arch: "arm64",
    address,
  });
  if (!registered.ok) throw new Error(registered.error);
  const sent: Record<string, unknown>[] = [];
  const ws = {
    data: { kind: "runner", runnerId: registered.runner.id },
    send: (frame: string) => sent.push(JSON.parse(frame)),
    close: () => {},
  };
  runnerWsOpen(ws);
  runnerWsMessage(ws, JSON.stringify({ t: "hello", version: 1 }));
  return { id: registered.runner.id, ws, sent };
}

function viewer(runnerId: string, connectionId: string) {
  const received: (string | Buffer)[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const ws = {
    data: {
      vmDisplay: {
        connectionId,
        runnerId,
        vm: "sbx-session-1",
        sessionId: "session-1",
      },
    },
    send: (frame: string | Buffer) => received.push(frame),
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
  };
  return { ws, received, closes };
}

describe("Mac VM display bridge", () => {
  test("the stream path is a session route on this origin", () => {
    expect(vmDisplayStreamPath("bks-1/x")).toBe(
      "/api/sessions/bks-1%2Fx/sandbox/desktop/stream",
    );
  });

  test("relays bytes both ways for one viewer and names only the VM", () => {
    const runner = connectedRunner();
    const view = viewer(runner.id, "a1b2c3d4e5f6a7b8");
    expect(vmDisplayOpen(view.ws)).toBe(true);
    expect(runner.sent.at(-1)).toMatchObject({
      t: "vm_display_open",
      connectionId: "a1b2c3d4e5f6a7b8",
      vm: "sbx-session-1",
    });
    expect(Object.keys(runner.sent.at(-1)!).sort()).toEqual(
      ["connectionId", "t", "version", "vm"].sort(),
    );

    runnerWsMessage(
      runner.ws,
      JSON.stringify({
        t: "vm_display_event",
        connectionId: "a1b2c3d4e5f6a7b8",
        data: Buffer.from("RFB 003.008\n").toString("base64"),
      }),
    );
    expect(view.received).toHaveLength(1);
    expect(Buffer.from(view.received[0] as Buffer).toString()).toBe(
      "RFB 003.008\n",
    );

    expect(vmDisplayMessage(view.ws, Buffer.from("RFB 003.008\n"))).toBe(true);
    expect(runner.sent.at(-1)).toMatchObject({
      t: "vm_display_send",
      connectionId: "a1b2c3d4e5f6a7b8",
      data: Buffer.from("RFB 003.008\n").toString("base64"),
    });
    // Text frames are not part of the binary protocol and never cross.
    const before = runner.sent.length;
    expect(vmDisplayMessage(view.ws, "hello")).toBe(true);
    expect(runner.sent).toHaveLength(before);

    expect(vmDisplayClose(view.ws)).toBe(true);
    expect(runner.sent.at(-1)).toMatchObject({
      t: "vm_display_close",
      connectionId: "a1b2c3d4e5f6a7b8",
    });
    expect(vmDisplayViewerCount()).toBe(0);
    runnerWsClose(runner.ws);
  });

  test("a frame for another viewer or from another Runner is dropped", () => {
    const runner = connectedRunner();
    const view = viewer(runner.id, "b1b2c3d4e5f6a7b8");
    vmDisplayOpen(view.ws);
    runnerWsMessage(
      runner.ws,
      JSON.stringify({
        t: "vm_display_event",
        connectionId: "somebody-else-0000",
        data: Buffer.from("x").toString("base64"),
      }),
    );
    expect(view.received).toHaveLength(0);
    const other = connectedRunner("other-mac", "100.101.102.104");
    runnerWsMessage(
      other.ws,
      JSON.stringify({
        t: "vm_display_event",
        connectionId: "b1b2c3d4e5f6a7b8",
        data: Buffer.from("x").toString("base64"),
      }),
    );
    expect(view.received).toHaveLength(0);
    vmDisplayClose(view.ws);
    runnerWsClose(runner.ws);
    runnerWsClose(other.ws);
  });

  test("the Runner closing the display closes the viewer with its reason", () => {
    const runner = connectedRunner();
    const view = viewer(runner.id, "c1b2c3d4e5f6a7b8");
    vmDisplayOpen(view.ws);
    runnerWsMessage(
      runner.ws,
      JSON.stringify({
        t: "vm_display_closed",
        connectionId: "c1b2c3d4e5f6a7b8",
        error: "Mac VM sbx-session-1 has not published its display yet.",
      }),
    );
    expect(view.closes).toEqual([
      {
        code: 1011,
        reason: "Mac VM sbx-session-1 has not published its display yet.",
      },
    ]);
    expect(vmDisplayViewerCount()).toBe(0);
    runnerWsClose(runner.ws);
  });

  test("an offline Mac host refuses the viewer at once", () => {
    const view = viewer("runner-missing", "d1b2c3d4e5f6a7b8");
    expect(vmDisplayOpen(view.ws)).toBe(true);
    expect(view.closes).toEqual([
      { code: 1011, reason: "Mac host is offline" },
    ]);
    expect(vmDisplayViewerCount()).toBe(0);
  });

  test("UI sockets are not display viewers", () => {
    const ws = { data: { watchingSessionId: null }, send() {}, close() {} };
    expect(vmDisplayOpen(ws)).toBe(false);
    expect(vmDisplayMessage(ws, "{}")).toBe(false);
    expect(vmDisplayClose(ws)).toBe(false);
  });
});
