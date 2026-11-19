/**
 * The display of a Mac VM, bridged to the browser.
 *
 * A Mac VM shows its screen through a VNC server the browser cannot reach
 * directly: on a paired Mac (Tart) it listens on the Mac's own loopback; on
 * use.computer it sits behind the service's authenticated WebSocket. The
 * browser's viewer connects here, on the app's authenticated origin, and
 * every byte crosses either the Runner channel as a typed `vm_display_*`
 * frame or a socket this server opens to the service. Nothing on the browser
 * side names a host, a port, or a credential; the per-viewer connection id is
 * random and known only to this socket.
 */

import { randomBytes } from "crypto";
import { audit } from "./audit";
import {
  registerRunnerDisplayFrameHandler,
  sendRunnerDisplayFrame,
} from "./runner-ws";

export interface VmDisplayWsData {
  vmDisplay: {
    connectionId: string;
    sessionId: string;
    /** A VM on a paired Mac: frames ride the Runner channel. */
    runnerId?: string;
    vm?: string;
    /** A hosted VM: frames ride a socket this server opens to the service. */
    socket?: { url: string; headers: Record<string, string> };
  };
}

type Viewer = {
  ws: any;
  runnerId?: string;
  upstream?: WebSocket;
  /** Browser bytes sent before the upstream socket opened. */
  queue: Uint8Array<ArrayBuffer>[];
};
const state = globalThis as {
  __opensessionVmDisplayViewers?: Map<string, Viewer>;
  __opensessionVmDisplayFramesInstalled?: boolean;
};
const viewers = (state.__opensessionVmDisplayViewers ??= new Map());

const STREAM_PATH = /^\/api\/sessions\/([^/]+)\/sandbox\/desktop\/stream$/;

/** Where a session's viewer connects; the provider hands this to the browser. */
export function vmDisplayStreamPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/sandbox/desktop/stream`;
}

export function isVmDisplayRoute(path: string): boolean {
  return STREAM_PATH.test(path);
}

/** Upgrade an authenticated viewer. The request already passed the API sign-in
 * gate; this resolves the session's VM and where its display is before
 * accepting. */
export async function handleVmDisplayUpgrade(
  req: Request,
  server: { upgrade(req: Request, opts?: { data?: unknown }): boolean },
  path: string,
): Promise<Response | undefined> {
  const match = path.match(STREAM_PATH);
  if (!match) return new Response("not found", { status: 404 });
  const { findSessionAsync } = await import("./session-cache");
  const session = await findSessionAsync(decodeURIComponent(match[1]!));
  if (!session) return new Response("Session not found", { status: 404 });
  const recorded = session.sandbox;
  if (
    !recorded?.sandboxId ||
    (recorded.provider !== "tart" && recorded.provider !== "usecomputer")
  )
    return new Response("This session has no Mac VM display", {
      status: 400,
    });
  const display: Omit<
    VmDisplayWsData["vmDisplay"],
    "connectionId" | "sessionId"
  > = {};
  try {
    if (recorded.provider === "tart") {
      const { tartDisplayHost } = await import("./sandbox/adapters/tart");
      const host = await tartDisplayHost(recorded.sandboxId);
      display.runnerId = host.runnerId;
      display.vm = host.vm;
    } else {
      const { useComputerDisplayUpstream } =
        await import("./sandbox/adapters/usecomputer");
      display.socket = await useComputerDisplayUpstream(recorded.sandboxId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(message, {
      status: /wake the sandbox/i.test(message) ? 409 : 502,
    });
  }
  const data: VmDisplayWsData = {
    vmDisplay: {
      connectionId: randomBytes(16).toString("hex"),
      sessionId: session.id,
      ...display,
    },
  };
  audit({
    msg: "sandbox_desktop_stream",
    session_id: session.id,
    provider: recorded.provider,
    sandbox_id: recorded.sandboxId,
  });
  if (!server.upgrade(req, { data }))
    return new Response("WebSocket upgrade failed", { status: 400 });
  return undefined;
}

function closeReason(text: unknown): string {
  return String(text || "").slice(0, 120);
}

function viewerOf(ws: any): VmDisplayWsData["vmDisplay"] | undefined {
  return (ws?.data as Partial<VmDisplayWsData> | undefined)?.vmDisplay;
}

/** Open the socket to the service and pipe it to the viewer both ways. */
function openUpstream(
  viewer: Viewer,
  connectionId: string,
  socket: NonNullable<VmDisplayWsData["vmDisplay"]["socket"]>,
): void {
  const upstream = new WebSocket(socket.url, {
    headers: socket.headers,
  } as unknown as string[]);
  upstream.binaryType = "arraybuffer";
  viewer.upstream = upstream;
  const closeViewer = (code: number, reason: string) => {
    if (viewers.get(connectionId) === viewer) viewers.delete(connectionId);
    try {
      viewer.ws.close(code, closeReason(reason));
    } catch {}
  };
  upstream.onopen = () => {
    for (const chunk of viewer.queue) upstream.send(chunk);
    viewer.queue.length = 0;
  };
  upstream.onmessage = (event) => {
    if (typeof event.data === "string") return;
    try {
      viewer.ws.send(Buffer.from(event.data as ArrayBuffer));
    } catch {}
  };
  upstream.onerror = () => closeViewer(1011, "Display connection failed");
  upstream.onclose = (event) =>
    closeViewer(
      event.code === 1000 ? 1000 : 1011,
      event.reason || "Display closed",
    );
}

// ── WS event dispatch (early-return hooks for ws-handlers.ts) ─────────────────

export function vmDisplayOpen(ws: any): boolean {
  const viewer = viewerOf(ws);
  if (!viewer) return false;
  const entry: Viewer = { ws, runnerId: viewer.runnerId, queue: [] };
  viewers.set(viewer.connectionId, entry);
  if (viewer.socket) {
    openUpstream(entry, viewer.connectionId, viewer.socket);
    return true;
  }
  if (
    !viewer.runnerId ||
    !sendRunnerDisplayFrame(viewer.runnerId, {
      t: "vm_display_open",
      connectionId: viewer.connectionId,
      vm: viewer.vm,
    })
  ) {
    viewers.delete(viewer.connectionId);
    try {
      ws.close(1011, "Mac host is offline");
    } catch {}
  }
  return true;
}

export function vmDisplayMessage(ws: any, message: string | Buffer): boolean {
  const viewer = viewerOf(ws);
  if (!viewer) return false;
  // RFB is a binary protocol; a text frame is not part of it.
  if (typeof message === "string") return true;
  const entry = viewers.get(viewer.connectionId);
  if (viewer.socket) {
    const upstream = entry?.upstream;
    if (!entry || !upstream) return true;
    const bytes = new Uint8Array(message);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes);
    else if (upstream.readyState === WebSocket.CONNECTING)
      entry.queue.push(bytes);
    return true;
  }
  if (
    !viewer.runnerId ||
    !sendRunnerDisplayFrame(viewer.runnerId, {
      t: "vm_display_send",
      connectionId: viewer.connectionId,
      data: Buffer.from(message).toString("base64"),
    })
  ) {
    try {
      ws.close(1011, "Mac host is offline");
    } catch {}
  }
  return true;
}

export function vmDisplayClose(ws: any): boolean {
  const viewer = viewerOf(ws);
  if (!viewer) return false;
  const entry = viewers.get(viewer.connectionId);
  if (entry?.ws === ws) viewers.delete(viewer.connectionId);
  if (viewer.socket) {
    try {
      entry?.upstream?.close();
    } catch {}
    return true;
  }
  if (viewer.runnerId)
    sendRunnerDisplayFrame(viewer.runnerId, {
      t: "vm_display_close",
      connectionId: viewer.connectionId,
    });
  return true;
}

/** Frames from the Runner, delivered to the one viewer they belong to. */
export function relayVmDisplayFrame(
  runnerId: string,
  message: Record<string, unknown>,
): void {
  const connectionId =
    typeof message.connectionId === "string" ? message.connectionId : "";
  const viewer = viewers.get(connectionId);
  if (!viewer || viewer.runnerId !== runnerId) return;
  if (message.t === "vm_display_event") {
    if (typeof message.data !== "string") return;
    try {
      viewer.ws.send(Buffer.from(message.data, "base64"));
    } catch {}
    return;
  }
  if (message.t === "vm_display_closed") {
    viewers.delete(connectionId);
    try {
      viewer.ws.close(
        message.error ? 1011 : 1000,
        closeReason(message.error || "Display closed"),
      );
    } catch {}
  }
}

export function vmDisplayViewerCount(): number {
  return viewers.size;
}

if (!state.__opensessionVmDisplayFramesInstalled) {
  state.__opensessionVmDisplayFramesInstalled = true;
  registerRunnerDisplayFrameHandler(relayVmDisplayFrame);
}
