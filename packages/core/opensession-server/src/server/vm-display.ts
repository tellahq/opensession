/**
 * The display of a Mac VM, bridged to the browser.
 *
 * A Mac VM (Tart) shows its screen through a VNC server that the hosting Mac
 * runs on its own loopback. The browser's viewer connects here, on the app's
 * authenticated origin, and every byte crosses the Runner channel as a typed
 * `vm_display_*` frame. The Runner alone resolves which loopback port belongs
 * to the named VM; nothing on this side names a host or a port, and the
 * per-viewer connection id is random and known only to this socket.
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
    runnerId: string;
    vm: string;
    sessionId: string;
  };
}

type Viewer = { ws: any; runnerId: string };
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
 * gate; this resolves the session's VM and its Mac host before accepting. */
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
  if (recorded?.provider !== "tart" || !recorded.sandboxId)
    return new Response("This session has no Mac VM display", {
      status: 400,
    });
  let host: { runnerId: string; vm: string };
  try {
    const { tartDisplayHost } = await import("./sandbox/adapters/tart");
    host = await tartDisplayHost(recorded.sandboxId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(message, {
      status: /wake the sandbox/i.test(message) ? 409 : 502,
    });
  }
  const data: VmDisplayWsData = {
    vmDisplay: {
      connectionId: randomBytes(16).toString("hex"),
      runnerId: host.runnerId,
      vm: host.vm,
      sessionId: session.id,
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

// ── WS event dispatch (early-return hooks for ws-handlers.ts) ─────────────────

export function vmDisplayOpen(ws: any): boolean {
  const viewer = viewerOf(ws);
  if (!viewer) return false;
  viewers.set(viewer.connectionId, { ws, runnerId: viewer.runnerId });
  if (
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
  if (
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
  if (viewers.get(viewer.connectionId)?.ws === ws)
    viewers.delete(viewer.connectionId);
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
