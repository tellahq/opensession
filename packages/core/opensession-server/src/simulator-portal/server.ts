import type { ServerWebSocket } from "bun";
import type { IdbSimulator, SimulatorInput } from "./idb";
import { jpegFrames } from "./mjpeg";
import {
  simulatorKeyCodes,
  viewerInputSchema,
  type ViewerInput,
  type ViewerState,
} from "./protocol";

type ViewerSocket = ServerWebSocket<{ pending: number }>;

export function simulatorInput(
  input: ViewerInput,
  dimensions: { width: number; height: number },
): SimulatorInput {
  const x = (value: number) =>
    Math.min(
      dimensions.width - 1,
      Math.max(0, Math.round(value * dimensions.width)),
    );
  const y = (value: number) =>
    Math.min(
      dimensions.height - 1,
      Math.max(0, Math.round(value * dimensions.height)),
    );
  switch (input.type) {
    case "tap":
      return { kind: "tap", x: x(input.x), y: y(input.y) };
    case "swipe":
      return {
        kind: "swipe",
        x: x(input.x),
        y: y(input.y),
        endX: x(input.endX),
        endY: y(input.endY),
        duration: input.duration,
      };
    case "text":
      return { kind: "text", text: input.text };
    case "home":
      return { kind: "button", button: "HOME" };
    case "key":
      return { kind: "key", key: simulatorKeyCodes[input.key] };
  }
}

/** The Portal proxy supplies authentication. The helper binds only loopback,
 * accepts only its Portal origin, and gates WebSockets with a same-origin token. */
export function startSimulatorViewer(options: {
  port: number;
  origin: string;
  assets: ReadonlyMap<string, Blob>;
  openSimulator: () => Promise<IdbSimulator>;
  /** Testable idle deadline. Production closes a device after ten minutes without a viewer. */
  idleMs?: number;
}) {
  const origin = new URL(options.origin).origin;
  const token = crypto.randomUUID();
  const sockets = new Set<ViewerSocket>();
  let state: ViewerState = { phase: "starting" };
  let simulator: IdbSimulator | undefined;
  let closing = false;
  let lastFrame: Uint8Array | undefined;
  let stopVideo: (() => Promise<void>) | undefined;
  let videoTransition = Promise.resolve();
  let commands = Promise.resolve();
  let pending = 0;
  let deviceClose: Promise<void> | undefined;
  function closeDevice(): Promise<void> {
    return simulator ? (deviceClose ??= simulator.close()) : Promise.resolve();
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function armIdle() {
    clearTimeout(idleTimer);
    if (!closing && sockets.size === 0)
      idleTimer = setTimeout(
        () => {
          void stop().catch((error) =>
            console.error("Simulator cleanup failed", error),
          );
        },
        options.idleMs ?? 10 * 60_000,
      );
  }

  function send(ws: ViewerSocket, value: unknown) {
    if (ws.readyState === 1) ws.send(JSON.stringify(value));
  }
  function setState(next: ViewerState) {
    state = next;
    for (const ws of sockets) send(ws, { type: "state", state });
  }
  function fail(error: unknown) {
    setState({
      phase: "error",
      message:
        error instanceof Error ? error.message : "Simulator connection failed",
    });
    syncVideo();
  }
  function syncVideo() {
    videoTransition = videoTransition
      .then(async () => {
        const shouldStream =
          !closing && sockets.size > 0 && state.phase === "ready" && simulator;
        if (!shouldStream) {
          await stopVideo?.();
          stopVideo = undefined;
          lastFrame = undefined;
          if (state.phase === "error") await closeDevice();
          return;
        }
        if (stopVideo) return;
        const frames = jpegFrames((frame) => {
          lastFrame = frame;
          for (const ws of sockets) {
            // A slow browser drops frames rather than buffering seconds of video.
            if (ws.readyState === 1 && ws.getBufferedAmount() < 256 * 1024)
              ws.send(frame);
          }
        });
        stopVideo = await shouldStream.startVideo((chunk) => {
          try {
            frames(chunk);
          } catch (error) {
            fail(error);
          }
        }, fail);
      })
      .catch(async (error) => {
        const message =
          error instanceof Error ? error.message : "Simulator stream failed";
        setState({ phase: "error", message });
        const stop = stopVideo;
        stopVideo = undefined;
        await stop?.().catch(() => {});
        // Do not chain syncVideo from inside its own transition. Release the
        // device here even if viewers remain connected to the error screen.
        await closeDevice().catch((cause) => {
          setState({
            phase: "error",
            message: `${message}. Cleanup failed: ${cause instanceof Error ? cause.message : "restart this Portal"}`,
          });
        });
      });
  }

  const server = Bun.serve<{ pending: number }>({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 60,
    fetch(request, server) {
      const url = new URL(request.url);
      const allowedHost =
        url.host === new URL(origin).host ||
        url.host === `127.0.0.1:${server.port}`;
      if (!allowedHost)
        return new Response("Invalid viewer host", { status: 403 });
      if (request.method !== "GET")
        return new Response("Method not allowed", { status: 405 });
      if (url.pathname === "/socket") {
        if (
          request.headers.get("origin") !== origin ||
          url.searchParams.get("token") !== token
        )
          return new Response("Viewer authorization required", { status: 403 });
        if (sockets.size >= 4 || closing)
          return new Response("Viewer capacity reached", { status: 503 });
        return server.upgrade(request, { data: { pending: 0 } })
          ? undefined
          : new Response("WebSocket required", { status: 400 });
      }
      const headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'",
      };
      if (url.pathname === "/api/bootstrap")
        return Response.json({ token, state }, { headers });
      const file = options.assets.get(url.pathname);
      return file
        ? new Response(file, { headers })
        : new Response("Not found", { status: 404, headers });
    },
    websocket: {
      maxPayloadLength: 8_192,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        clearTimeout(idleTimer);
        if (closing || sockets.size >= 4) {
          ws.close(1013, "Viewer capacity reached");
          return;
        }
        sockets.add(ws);
        send(ws, { type: "state", state });
        if (lastFrame) ws.send(lastFrame);
        syncVideo();
      },
      message(ws, message) {
        if (typeof message !== "string")
          return ws.close(1003, "Text commands only");
        let json: unknown;
        try {
          json = JSON.parse(message);
        } catch {
          return ws.close(1008, "Invalid command");
        }
        const parsed = viewerInputSchema.safeParse(json);
        if (!parsed.success) return ws.close(1008, "Invalid command");
        const target = simulator;
        if (!target || state.phase !== "ready" || closing)
          return send(ws, {
            type: "input-error",
            message: "Simulator is not ready",
          });
        if (ws.data.pending >= 4 || pending >= 16)
          return send(ws, {
            type: "input-error",
            message: "Simulator is busy. Try again.",
          });
        ws.data.pending++;
        pending++;
        commands = commands
          .then(async () => {
            if (closing || state.phase !== "ready" || ws.readyState !== 1)
              return;
            await target.input(simulatorInput(parsed.data, target.dimensions));
          })
          .catch((error) =>
            send(ws, {
              type: "input-error",
              message:
                error instanceof Error
                  ? error.message
                  : "Simulator input failed",
            }),
          )
          .finally(() => {
            ws.data.pending--;
            pending--;
          });
      },
      close(ws) {
        sockets.delete(ws);
        syncVideo();
        armIdle();
      },
    },
  });
  const ready = options
    .openSimulator()
    .then(async (device) => {
      simulator = device;
      if (closing) return;
      setState({
        phase: "ready",
        deviceName: device.deviceName,
        ...device.dimensions,
      });
      syncVideo();
    })
    .catch(fail);
  let stopped: Promise<void> | undefined;
  function stop() {
    return (stopped ??= (async () => {
      closing = true;
      clearTimeout(idleTimer);
      for (const ws of sockets) ws.close(1001, "Simulator Portal stopped");
      sockets.clear();
      await server.stop(true);
      await ready;
      syncVideo();
      await videoTransition;
      await commands;
      await closeDevice();
    })());
  }
  armIdle();
  return { port: server.port, ready, stop };
}
