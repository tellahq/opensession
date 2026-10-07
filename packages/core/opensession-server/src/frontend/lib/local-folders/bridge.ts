/**
 * The device side of local folders (server/local-folders.ts).
 *
 * While any folder on this device is connected to a session, this window
 * keeps one dedicated socket to the server. On every connect and every change
 * it announces the folders it holds and the sessions each is connected to,
 * then answers file operations one at a time. Every window or tab of the
 * same device announces the same grants under the same device id, so the
 * folder stays reachable while any of them is open.
 */
import { z } from "zod";
import { getWebSocketUrl } from "../api";
import { os1Shell } from "../os1-shell";
import { webSocketReconnectDelay } from "../ws-reconnect";
import { getCurrentUser } from "../../components/UserPicker";
import { folderOpSchema, runFolderOp, type FolderOpResult } from "./ops";
import type { FolderGrant, LocalFolderProvider } from "./provider";
import {
  browserFoldersSupported,
  createBrowserFolderProvider,
} from "./browser-provider";
import {
  createElectronFolderProvider,
  nativeLocalFolders,
} from "./electron-provider";

export interface LocalFolderBridgeState {
  /** Null where this client cannot hold a folder (Safari, the phone app). */
  kind: LocalFolderProvider["kind"] | null;
  grants: FolderGrant[];
  connected: boolean;
}

const PING_MS = 25_000;

/** The frames this socket acts on. Anything else (hello, presence) is
 *  ignored. */
const serverFrameSchema = z.union([
  z.object({ type: z.literal("local_folders_ready") }),
  z.object({ type: z.literal("server_restarting") }),
  z.object({
    type: z.literal("local_folder_detach"),
    sessionId: z.string(),
    folderId: z.string(),
  }),
  z.intersection(
    z.object({
      type: z.literal("local_folder_op"),
      requestId: z.string(),
      sessionId: z.string(),
      folderId: z.string(),
    }),
    folderOpSchema,
  ),
]);
type ServerFrame = z.infer<typeof serverFrameSchema>;
type OpFrame = Extract<ServerFrame, { type: "local_folder_op" }>;
/** A frame that names an op this client does not know still gets an answer,
 *  so the agent is not left waiting for the timeout. */
const unknownOpSchema = z.object({
  type: z.literal("local_folder_op"),
  requestId: z.string(),
});

let provider: LocalFolderProvider | null | undefined;
let state: LocalFolderBridgeState = {
  kind: null,
  grants: [],
  connected: false,
};
const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
/** Resolved by the server's next acknowledgement of a hello. */
let readyWaiters: Array<() => void> = [];

function emit(next: Partial<LocalFolderBridgeState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function localFolderProvider(): LocalFolderProvider | null {
  if (provider !== undefined) return provider;
  if (typeof window === "undefined") return (provider = null);
  const shell = os1Shell();
  const native = nativeLocalFolders(shell);
  // Mac app builds without the native bridge deny the browser's folder
  // permission, so they offer nothing until they update.
  const olderShell = !!shell?.desktop;
  provider = native
    ? createElectronFolderProvider(native)
    : browserFoldersSupported() && !olderShell
      ? createBrowserFolderProvider()
      : null;
  return provider;
}

export function subscribeLocalFolders(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function localFolderState(): LocalFolderBridgeState {
  return state;
}

function needed(grants: FolderGrant[]): boolean {
  return grants.some((grant) => grant.usable && grant.sessionIds.length > 0);
}

async function hello(ws: WebSocket) {
  const p = localFolderProvider();
  if (!p || ws.readyState !== WebSocket.OPEN) return;
  const device = await p.device();
  ws.send(
    JSON.stringify({
      type: "local_folders_hello",
      user: getCurrentUser(),
      deviceId: device.id,
      deviceLabel: device.label,
      folders: state.grants
        .filter((grant) => grant.usable)
        .map((grant) => ({
          id: grant.id,
          name: grant.name,
          displayPath: grant.displayPath,
          readOnly: grant.readOnly,
          sessionIds: grant.sessionIds,
        })),
    }),
  );
}

type OpReply =
  | { ok: true; result: FolderOpResult }
  | { ok: false; error: string };

function reply(ws: WebSocket, requestId: string, body: OpReply) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(
      JSON.stringify({ type: "local_folder_result", requestId, ...body }),
    );
}

async function answer(ws: WebSocket, frame: OpFrame) {
  const p = localFolderProvider();
  try {
    const grant = state.grants.find((g) => g.id === frame.folderId);
    if (
      !p ||
      !grant ||
      !grant.usable ||
      !grant.sessionIds.includes(frame.sessionId)
    )
      throw new Error("This folder is not connected to that session");
    const result = await runFolderOp(p.access(grant.id), grant, frame);
    reply(ws, frame.requestId, { ok: true, result });
  } catch (error) {
    reply(ws, frame.requestId, {
      ok: false,
      error: error instanceof Error ? error.message : "The operation failed",
    });
  }
}

function closeSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  const ws = socket;
  socket = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  emit({ connected: false });
}

function openSocket() {
  if (socket || !needed(state.grants)) return;
  const ws = new WebSocket(getWebSocketUrl());
  socket = ws;
  let handoff = false;
  ws.onopen = () => {
    void hello(ws);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "ping" }));
    }, PING_MS);
  };
  ws.onmessage = (event) => {
    let raw;
    try {
      raw = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const parsed = serverFrameSchema.safeParse(raw);
    if (!parsed.success) {
      const op = unknownOpSchema.safeParse(raw);
      if (op.success)
        reply(ws, op.data.requestId, {
          ok: false,
          error:
            "Invalid or unsupported folder operation. Updating the app may help.",
        });
      return;
    }
    const frame = parsed.data;
    if (frame.type === "local_folders_ready") {
      emit({ connected: true });
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const resolve of waiters) resolve();
    } else if (frame.type === "local_folder_op") void answer(ws, frame);
    else if (frame.type === "local_folder_detach")
      void detachHere(frame.folderId, frame.sessionId);
    else handoff = true;
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    emit({ connected: false });
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        openSocket();
      },
      webSocketReconnectDelay(event.code, handoff),
    );
  };
}

/** Re-read grants and bring the socket in line with them. */
export async function refreshLocalFolders(): Promise<void> {
  const p = localFolderProvider();
  if (!p) return;
  const grants = await p.grants().catch(() => state.grants);
  emit({ kind: p.kind, grants });
  if (!needed(grants)) closeSocket();
  else if (socket?.readyState === WebSocket.OPEN) await hello(socket);
  else openSocket();
}

/** Called once at app start. Cheap when nothing is connected. */
export function startLocalFolderBridge(): void {
  if (started) return;
  started = true;
  const p = localFolderProvider();
  if (!p) return;
  emit({ kind: p.kind });
  p.onChange(() => void refreshLocalFolders());
  void refreshLocalFolders();
}

async function detachHere(folderId: string, sessionId: string) {
  const p = localFolderProvider();
  const grant = state.grants.find((g) => g.id === folderId);
  if (!p || !grant || !grant.sessionIds.includes(sessionId)) return;
  await p.update(folderId, {
    sessionIds: grant.sessionIds.filter((id) => id !== sessionId),
  });
  await refreshLocalFolders();
}

/** Pick a folder with the system picker and connect it to a session. */
export async function connectLocalFolder(
  sessionId: string,
): Promise<FolderGrant | null> {
  const p = localFolderProvider();
  if (!p) throw new Error("This app cannot open local folders");
  startLocalFolderBridge();
  const grant = await p.pick();
  if (!grant) return null;
  if (!grant.sessionIds.includes(sessionId))
    await p.update(grant.id, { sessionIds: [...grant.sessionIds, sessionId] });
  await refreshLocalFolders();
  return grant;
}

export async function disconnectLocalFolder(
  folderId: string,
  sessionId: string,
): Promise<void> {
  await detachHere(folderId, sessionId);
  const p = localFolderProvider();
  const grant = state.grants.find((g) => g.id === folderId);
  // A folder no session uses any more is forgotten entirely.
  if (p && grant && grant.sessionIds.length === 0) {
    await p.remove(folderId);
    await refreshLocalFolders();
  }
}

export async function setLocalFolderReadOnly(
  folderId: string,
  readOnly: boolean,
): Promise<void> {
  const p = localFolderProvider();
  if (!p) return;
  await p.update(folderId, { readOnly });
  await refreshLocalFolders();
}

/** Browser only: ask for access again after a restart. Call from a click. */
export async function reauthorizeLocalFolder(
  folderId: string,
): Promise<boolean> {
  const p = localFolderProvider();
  if (!p?.reauthorize) return true;
  const ok = await p.reauthorize(folderId);
  await refreshLocalFolders();
  return ok;
}

export async function localFolderDeviceId(): Promise<string | null> {
  const p = localFolderProvider();
  return p ? (await p.device()).id : null;
}

/** Pick a folder with the system picker without connecting it anywhere yet
 *  (the New-session box, before the session exists). */
export async function pickLocalFolder(): Promise<FolderGrant | null> {
  const p = localFolderProvider();
  if (!p) throw new Error("This app cannot open local folders");
  startLocalFolderBridge();
  const grant = await p.pick();
  await refreshLocalFolders();
  return grant;
}

/**
 * Connect picked folders to a session that is about to be created, and wait
 * (briefly) until the server has them, so the opening turn is told about
 * them. A slow or missing acknowledgement does not block the create: the
 * folders still reach the session as soon as the socket catches up.
 */
export async function attachLocalFolders(
  folderIds: string[],
  sessionId: string,
  timeoutMs = 3_000,
): Promise<void> {
  const p = localFolderProvider();
  if (!p || !folderIds.length) return;
  startLocalFolderBridge();
  const acknowledged = new Promise<void>((resolve) => {
    readyWaiters.push(resolve);
    setTimeout(resolve, timeoutMs);
  });
  for (const id of folderIds) {
    const grant = state.grants.find((g) => g.id === id);
    if (grant && !grant.sessionIds.includes(sessionId))
      await p.update(id, { sessionIds: [...grant.sessionIds, sessionId] });
  }
  await refreshLocalFolders();
  await acknowledged;
}

/** Drop a picked folder that no session ended up using. */
export async function forgetUnusedLocalFolder(folderId: string): Promise<void> {
  const p = localFolderProvider();
  const grant = state.grants.find((g) => g.id === folderId);
  if (!p || !grant || grant.sessionIds.length) return;
  await p.remove(folderId);
  await refreshLocalFolders();
}
