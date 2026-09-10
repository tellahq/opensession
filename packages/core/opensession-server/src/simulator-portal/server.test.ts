import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { startSimulatorViewer, simulatorInput } from "./server";
import type { IdbSimulator, SimulatorInput } from "./idb";
import { jpegFrames } from "./mjpeg";
import { viewerInputSchema } from "./protocol";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await Bun.sleep(5);
  }
}

function fixture(overrides: Partial<IdbSimulator> = {}, idleMs?: number) {
  const inputs: SimulatorInput[] = [];
  let starts = 0;
  let stops = 0;
  let closed = 0;
  let emit: (chunk: Uint8Array) => void = () => {};
  const device: IdbSimulator = {
    udid: "fixture",
    deviceName: "Test device",
    dimensions: { width: 400, height: 800 },
    density: 3,
    async input(command) {
      inputs.push(command);
    },
    async startVideo(onChunk) {
      starts++;
      emit = onChunk;
      return async () => {
        stops++;
      };
    },
    async close() {
      closed++;
    },
    ...overrides,
  };
  const origin = "https://simulator.example.test:9000";
  const viewer = startSimulatorViewer({
    port: 0,
    origin,
    assets: new Map([["/", new Blob(["Test viewer"], { type: "text/html" })]]),
    openSimulator: async () => device,
    idleMs,
  });
  cleanup.push(() => viewer.stop());
  const base = `http://127.0.0.1:${viewer.port}`;
  async function connect() {
    const { token } = z
      .object({ token: z.string() })
      .parse(await (await fetch(`${base}/api/bootstrap`)).json());
    // Bun supports custom handshake headers; this checkout also includes DOM
    // types whose WebSocket constructor exposes only browser arguments.
    const client: unknown = Reflect.construct(WebSocket, [
      `${base.replace("http:", "ws:")}/socket?token=${token}`,
      { headers: { Origin: origin } } satisfies Bun.WebSocketOptions,
    ]);
    if (!(client instanceof WebSocket)) throw new Error("Expected a WebSocket");
    const ws = client;
    cleanup.push(() => ws.close());
    const messages: Array<string | Uint8Array> = [];
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) =>
      messages.push(
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data),
      ),
    );
    await until(() => ws.readyState === WebSocket.OPEN && messages.length > 0);
    return { ws, messages };
  }
  return {
    viewer,
    base,
    origin,
    inputs,
    connect,
    emit: (data: Uint8Array) => emit(data),
    counts: () => ({ starts, stops, closed }),
  };
}

test("JPEG stream handles chunk boundaries and concatenated frames without unbounded buffering", () => {
  const received: Uint8Array[] = [];
  const append = jpegFrames((frame) => received.push(frame));
  append(Buffer.from([0, 255]));
  append(Buffer.from([216, 1, 2, 255]));
  append(Buffer.from([217, 255, 216, 3, 255, 217]));
  expect(received.map((value) => [...value])).toEqual([
    [255, 216, 1, 2, 255, 217],
    [255, 216, 3, 255, 217],
  ]);
  expect(() =>
    append(
      Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(4 * 1024 * 1024)]),
    ),
  ).toThrow("4 MiB");
});

test("viewer commands are validated and mapped to logical points, never raw CLI arguments", () => {
  expect(
    simulatorInput({ type: "tap", x: 1, y: 0.5 }, { width: 400, height: 800 }),
  ).toEqual({ kind: "tap", x: 399, y: 400 });
  expect(
    simulatorInput(
      { type: "key", key: "Backspace" },
      { width: 400, height: 800 },
    ),
  ).toEqual({ kind: "key", key: 42 });
  for (const invalid of [
    { type: "tap", x: -1, y: 0 },
    { type: "tap", x: Infinity, y: 0 },
    { type: "swipe", x: 0, y: 0, endX: 1, endY: 1, duration: 60 },
    { type: "key", key: "; rm" },
    { type: "text", text: "x".repeat(1001) },
    { type: "home", udid: "another-device" },
  ])
    expect(viewerInputSchema.safeParse(invalid).success).toBe(false);
});

test("helper rejects foreign hosts, cross-origin control, absent tokens, and mutation HTTP verbs", async () => {
  const { base, origin } = fixture();
  const bootstrap = await fetch(`${base}/api/bootstrap`);
  expect(bootstrap.headers.get("cache-control")).toBe("no-store");
  expect(bootstrap.headers.get("access-control-allow-origin")).toBeNull();
  const { token } = z
    .object({ token: z.string() })
    .parse(await bootstrap.json());
  expect(
    (await fetch(base, { headers: { Host: "attacker.example" } })).status,
  ).toBe(403);
  expect((await fetch(base, { method: "POST" })).status).toBe(405);
  expect(
    (
      await fetch(`${base}/socket?token=${token}`, {
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${base}/socket`, { headers: { Origin: origin } })).status,
  ).toBe(403);
});

test("real WebSocket transports frames/input, shares one stream, and stops capture with the last viewer", async () => {
  const f = fixture();
  const first = await f.connect();
  const second = await f.connect();
  await until(() => f.counts().starts === 1);
  f.emit(Buffer.from([255, 216, 7, 255, 217]));
  await until(
    () =>
      first.messages.some((value) => typeof value !== "string") &&
      second.messages.some((value) => typeof value !== "string"),
  );
  first.ws.send(JSON.stringify({ type: "tap", x: 0.25, y: 0.75 }));
  first.ws.send(JSON.stringify({ type: "text", text: "hello" }));
  await until(() => f.inputs.length === 2);
  expect(f.inputs).toEqual([
    { kind: "tap", x: 100, y: 600 },
    { kind: "text", text: "hello" },
  ]);
  first.ws.close();
  second.ws.close();
  await until(() => f.counts().stops === 1);
  expect(f.counts().closed).toBe(0);
  await f.viewer.stop();
  expect(f.counts().closed).toBe(1);
});

test("invalid input closes the connection without controlling a simulator", async () => {
  const f = fixture();
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "tap", x: 2, y: 0 }));
  await until(() => ws.readyState === WebSocket.CLOSED);
  expect(f.inputs).toEqual([]);
});

test("setup failures remain visible in the Portal rather than pretending a device is ready", async () => {
  const viewer = startSimulatorViewer({
    port: 0,
    origin: "https://viewer.test",
    assets: new Map(),
    openSimulator: async () => {
      throw new Error("Xcode is missing");
    },
  });
  cleanup.push(() => viewer.stop());
  await viewer.ready;
  expect(
    await (await fetch(`http://127.0.0.1:${viewer.port}/api/bootstrap`)).json(),
  ).toMatchObject({ state: { phase: "error", message: "Xcode is missing" } });
});

test("a capture spawn failure releases the simulator even with an error viewer connected", async () => {
  const f = fixture({
    startVideo: async () => {
      throw new Error("idb capture spawn failed");
    },
  });
  await f.connect();
  await until(() => f.counts().closed === 1);
  expect(await (await fetch(`${f.base}/api/bootstrap`)).json()).toMatchObject({
    state: { phase: "error", message: "idb capture spawn failed" },
  });
  await f.viewer.stop();
  expect(f.counts().closed).toBe(1);
});

test("a failed capture stop still closes the device", async () => {
  const f = fixture({
    startVideo: async () => async () => {
      throw new Error("capture did not stop");
    },
  });
  const { ws } = await f.connect();
  ws.close();
  await until(() => f.counts().closed === 1);
  await f.viewer.stop();
  expect(f.counts().closed).toBe(1);
});

test("idle viewers release their device and listener", async () => {
  const f = fixture({}, 20);
  await until(() => f.counts().closed === 1);
  await f.viewer.stop();
  expect(f.counts().closed).toBe(1);
});
