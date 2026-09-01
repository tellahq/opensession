/** Runner-owned Portal supervisor facade.
 *
 * The service process and port live on the Runner. The server owns policy,
 * audit, session association, and the later authenticated browser relay. No
 * Portal command can name an arbitrary host or leave its session workspace.
 */

import { existsSync, readFileSync } from "fs";
import { statePath } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  registerRunnerPortalFrameHandler,
  requestRunnerPortal,
  sendRunnerPortalFrame,
} from "./runner-ws";
import { getRunner, runnerAllowed } from "./runners";
import type { UnifiedSession } from "./types";
import type { PortalRecord } from "./portal-supervisor";
import {
  ensureAuthenticatedPortalRoute,
  dropAuthenticatedPortalRoute,
} from "./preview";
import {
  releaseSandboxPreviewPorts,
  sandboxHttpsPortFor,
} from "./sandbox/preview-ports";
import { findSession, getSessionListSnapshotAsync } from "./session-cache";

export type RunnerPortalRecord = PortalRecord & {
  runnerId: string;
  sessionId: string;
  repo: string;
  workspacePath: string;
  /** Portal authorization is user-scoped on restricted Runners. */
  user?: string;
};

type Store = { portals: RunnerPortalRecord[] };
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_RELAY_BODY = 5 * 1024 * 1024;
const RUNNER_PORTAL_REAP_INTERVAL_MS = 5 * 60_000;
const HOP_HEADERS = new Set([
  "connection",
  "host",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

type RunnerPortalRelay = {
  server: ReturnType<typeof Bun.serve>;
  record: RunnerPortalRecord;
};
const g = globalThis as {
  __opensessionRunnerPortalRelays?: Map<string, RunnerPortalRelay>;
};
const relays = (g.__opensessionRunnerPortalRelays ??= new Map());
type BrowserPortalSocket = { ws: any; record: RunnerPortalRecord };
const socketState = globalThis as {
  __opensessionRunnerPortalSockets?: Map<string, BrowserPortalSocket>;
  __opensessionRunnerPortalFramesInstalled?: boolean;
};
const browserSockets = (socketState.__opensessionRunnerPortalSockets ??=
  new Map());

function storePath(): string {
  return statePath(".opensession-runner-portals.json");
}
function load(): Store {
  try {
    const parsed = existsSync(storePath())
      ? JSON.parse(readFileSync(storePath(), "utf8"))
      : null;
    return Array.isArray(parsed?.portals)
      ? { portals: parsed.portals }
      : { portals: [] };
  } catch {
    return { portals: [] };
  }
}
function save(store: Store): void {
  writeJsonAtomic(storePath(), store);
}
function remove(records: readonly RunnerPortalRecord[]): void {
  if (!records.length) return;
  const keys = new Set(
    records.map(
      (record) => `${record.runnerId}:${record.sessionId}:${record.name}`,
    ),
  );
  const store = load();
  save({
    portals: store.portals.filter(
      (record) =>
        !keys.has(`${record.runnerId}:${record.sessionId}:${record.name}`),
    ),
  });
}
function upsert(record: RunnerPortalRecord): void {
  const store = load();
  const index = store.portals.findIndex(
    (item) =>
      item.runnerId === record.runnerId &&
      item.sessionId === record.sessionId &&
      item.name === record.name,
  );
  if (index < 0) store.portals.push(record);
  else store.portals[index] = record;
  save(store);
}

function relayKey(record: RunnerPortalRecord): string {
  return `${record.runnerId}:${record.sessionId}:${record.port}`;
}
function relayScope(record: RunnerPortalRecord): string {
  return `runner-${record.runnerId}-${record.sessionId}`;
}
function relayHttpsPort(record: RunnerPortalRecord): number {
  return sandboxHttpsPortFor(relayScope(record), record.port);
}

function safeRequestHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of headers)
    if (!HOP_HEADERS.has(name.toLowerCase()) && value.length <= 8_192)
      forwarded[name] = value;
  return forwarded;
}

function relaySocketFrame(
  runnerId: string,
  message: Record<string, unknown>,
): void {
  const connectionId =
    typeof message.connectionId === "string" ? message.connectionId : "";
  const socket = browserSockets.get(connectionId);
  if (!socket || socket.record.runnerId !== runnerId) return;
  if (message.t === "portal_ws_event") {
    try {
      if (message.binary === true && typeof message.data === "string")
        socket.ws.send(Buffer.from(message.data, "base64"));
      else if (typeof message.data === "string") socket.ws.send(message.data);
    } catch {}
    return;
  }
  if (message.t === "portal_ws_closed") {
    browserSockets.delete(connectionId);
    try {
      socket.ws.close();
    } catch {}
  }
}

if (!socketState.__opensessionRunnerPortalFramesInstalled) {
  socketState.__opensessionRunnerPortalFramesInstalled = true;
  registerRunnerPortalFrameHandler(relaySocketFrame);
}

async function relayResponse(
  record: RunnerPortalRecord,
  request: Request,
): Promise<Response> {
  const session = findSession(record.sessionId);
  if (!session?.runner || session.runner.id !== record.runnerId)
    return new Response("Portal is no longer available", { status: 404 });
  let body = "";
  if (request.method !== "GET" && request.method !== "HEAD") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_RELAY_BODY)
      return new Response("Portal request is too large", { status: 413 });
    body = Buffer.from(bytes).toString("base64");
  }
  try {
    const result = (await requestRunnerPortal(record.runnerId, {
      sessionId: record.sessionId,
      repo: record.repo,
      workspacePath: record.workspacePath,
      operation: "http",
      user: session.startedBy || undefined,
      payload: {
        port: record.port,
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers: safeRequestHeaders(request.headers),
        ...(body ? { body } : {}),
      },
    })) as { status?: unknown; headers?: unknown; body?: unknown };
    const status =
      typeof result.status === "number" && Number.isInteger(result.status)
        ? result.status
        : 502;
    const headers = new Headers();
    if (
      result.headers &&
      typeof result.headers === "object" &&
      !Array.isArray(result.headers)
    ) {
      for (const [name, value] of Object.entries(
        result.headers as Record<string, unknown>,
      ))
        if (!HOP_HEADERS.has(name.toLowerCase()) && typeof value === "string")
          headers.set(name, value);
    }
    const responseBody =
      typeof result.body === "string"
        ? Buffer.from(result.body, "base64")
        : undefined;
    if (responseBody && responseBody.byteLength > 10 * 1024 * 1024)
      return new Response("Runner Portal response is too large", {
        status: 502,
      });
    return new Response(responseBody, { status, headers });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Runner Portal relay failed",
      { status: 502 },
    );
  }
}

async function ensureRelay(record: RunnerPortalRecord): Promise<string | null> {
  const key = relayKey(record);
  let relay = relays.get(key);
  if (!relay) {
    const portalRecord = record;
    const server = Bun.serve<{
      connectionId: string;
      record: RunnerPortalRecord;
      path: string;
      headers: Record<string, string>;
    }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, relayServer) {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const connectionId = crypto.randomUUID().replaceAll("-", "");
          const url = new URL(request.url);
          return relayServer.upgrade(request, {
            data: {
              connectionId,
              record: portalRecord,
              path: url.pathname + url.search,
              headers: safeRequestHeaders(request.headers),
            },
          })
            ? undefined
            : new Response("WebSocket upgrade failed", { status: 400 });
        }
        return relayResponse(portalRecord, request);
      },
      websocket: {
        open(ws) {
          browserSockets.set(ws.data.connectionId, {
            ws,
            record: ws.data.record,
          });
          const request = ws.data as {
            connectionId: string;
            record: RunnerPortalRecord;
            path: string;
            headers: Record<string, string>;
          };
          if (
            !sendRunnerPortalFrame(request.record.runnerId, {
              t: "portal_ws_open",
              connectionId: request.connectionId,
              sessionId: request.record.sessionId,
              repo: request.record.repo,
              workspacePath: request.record.workspacePath,
              port: request.record.port,
              path: request.path,
              headers: request.headers,
            })
          ) {
            browserSockets.delete(request.connectionId);
            try {
              ws.close();
            } catch {}
          }
        },
        message(ws, message) {
          const request = ws.data as {
            connectionId: string;
            record: RunnerPortalRecord;
          };
          const binary = typeof message !== "string";
          const data = binary
            ? Buffer.from(message as any).toString("base64")
            : message;
          if (
            !sendRunnerPortalFrame(request.record.runnerId, {
              t: "portal_ws_send",
              connectionId: request.connectionId,
              binary,
              data,
            })
          ) {
            try {
              ws.close();
            } catch {}
          }
        },
        close(ws) {
          const request = ws.data as {
            connectionId: string;
            record: RunnerPortalRecord;
          };
          browserSockets.delete(request.connectionId);
          sendRunnerPortalFrame(request.record.runnerId, {
            t: "portal_ws_close",
            connectionId: request.connectionId,
          });
        },
      },
    });
    relay = { server, record };
    relays.set(key, relay);
  }
  return ensureAuthenticatedPortalRoute(
    relayHttpsPort(record),
    `127.0.0.1:${relay.server.port}`,
  );
}

async function dropRelay(record: RunnerPortalRecord): Promise<void> {
  const relay = relays.get(relayKey(record));
  if (relay) {
    try {
      relay.server.stop(true);
    } catch {}
    relays.delete(relayKey(record));
  }
  await dropAuthenticatedPortalRoute(relayHttpsPort(record));
}

export async function runnerPortalUrl(
  record: RunnerPortalRecord,
): Promise<string | null> {
  return record.state === "awake" ? ensureRelay(record) : null;
}

export async function runnerPortalPreviewStatus(
  session: UnifiedSession,
  user?: string,
) {
  const portals = await listRunnerPortalServices(session, user);
  const services = await Promise.all(
    portals.map(async (portal) => ({
      name: portal.name,
      key: portal.key,
      port: portal.port,
      running: portal.state === "awake",
      pids: [],
      previewUrl: await runnerPortalUrl(portal),
      description: portal.description,
      defaultPath: portal.defaultPath,
      state: portal.state,
      managed: true,
    })),
  );
  const webapp =
    services.find((service) => service.key === "WEBAPP_PORT") ?? services[0];
  return {
    hasPortsConf: services.length > 0,
    webappPort: webapp?.port ?? null,
    running: Boolean(webapp?.running),
    starting: services.some((service) => service.state === "starting"),
    previewUrl: webapp?.previewUrl ?? null,
    bootable: true,
    services,
    portalRecipes: [],
  };
}

/** Tear down every relay and Caddy allocation when a Runner session is
 * removed. Called by session lifecycle code, never by a browser request. */
async function dropRecords(
  records: readonly RunnerPortalRecord[],
): Promise<void> {
  for (const record of records) {
    const relay = relays.get(relayKey(record));
    if (relay) {
      try {
        relay.server.stop(true);
      } catch {}
      relays.delete(relayKey(record));
    }
  }
  for (const record of records)
    await dropAuthenticatedPortalRoute(relayHttpsPort(record));
  for (const scope of new Set(records.map(relayScope))) {
    for (const httpsPort of releaseSandboxPreviewPorts(scope))
      await dropAuthenticatedPortalRoute(httpsPort);
  }
}

export async function dropRunnerPortalRoutes(
  sessionId: string,
  runnerId?: string,
  user?: string,
): Promise<void> {
  const records = load().portals.filter(
    (record) =>
      record.sessionId === sessionId &&
      (!runnerId || record.runnerId === runnerId),
  );
  const stopped: RunnerPortalRecord[] = [];
  for (const record of records) {
    try {
      if (record.state !== "stopped")
        await requestRunnerPortal(record.runnerId, {
          sessionId: record.sessionId,
          repo: record.repo,
          workspacePath: record.workspacePath,
          operation: "stop",
          user: user ?? record.user,
          payload: { name: record.name },
        });
      stopped.push(record);
    } catch (error) {
      // Keep the record for the boot/ticker reaper. An offline Runner must
      // not turn a transient network error into an unrecoverable orphan.
      console.warn(
        `[runner-portals] could not stop ${record.name} for ${record.sessionId}:`,
        error,
      );
    }
  }
  await dropRecords(records);
  remove(stopped);
}

export async function dropRunnerPortalsForRunner(
  runnerId: string,
): Promise<void> {
  const records = load().portals.filter(
    (record) => record.runnerId === runnerId,
  );
  await dropRunnerPortalRoutesForRecords(records);
  remove(records);
}

async function dropRunnerPortalRoutesForRecords(
  records: readonly RunnerPortalRecord[],
): Promise<void> {
  for (const record of records) {
    try {
      if (record.state !== "stopped")
        await requestRunnerPortal(record.runnerId, {
          sessionId: record.sessionId,
          repo: record.repo,
          workspacePath: record.workspacePath,
          operation: "stop",
          user: record.user,
          payload: { name: record.name },
        });
    } catch (error) {
      console.warn(
        `[runner-portals] could not stop ${record.name} for ${record.sessionId}:`,
        error,
      );
    }
  }
  await dropRecords(records);
}

/** Records whose session vanished while its Runner process could outlive us. */
export function orphanedRunnerPortalRecords(
  records: readonly RunnerPortalRecord[],
  liveSessionIds: ReadonlySet<string>,
): RunnerPortalRecord[] {
  return records.filter((record) => !liveSessionIds.has(record.sessionId));
}

/** Retry teardown for remote Portals that outlived a crashed session delete. */
export async function reapOrphanedRunnerPortals(): Promise<number> {
  const sessions = await getSessionListSnapshotAsync();
  const records = orphanedRunnerPortalRecords(
    load().portals,
    new Set(sessions.map((session) => session.id)),
  );
  if (!records.length) return 0;
  const stopped: RunnerPortalRecord[] = [];
  for (const record of records) {
    try {
      if (record.state !== "stopped")
        await requestRunnerPortal(record.runnerId, {
          sessionId: record.sessionId,
          repo: record.repo,
          workspacePath: record.workspacePath,
          operation: "stop",
          user: record.user,
          payload: { name: record.name },
        });
      stopped.push(record);
    } catch (error) {
      console.warn(
        `[runner-portals] orphan ${record.name} for ${record.sessionId} is not reachable yet:`,
        error,
      );
    }
  }
  await dropRecords(records);
  remove(stopped);
  return stopped.length;
}

let runnerPortalReapTimer: ReturnType<typeof setInterval> | null = null;

/** Reap durable Runner Portal records after boot and while the server runs. */
export function startRunnerPortalReaper(): void {
  if (runnerPortalReapTimer) return;
  const run = () =>
    void reapOrphanedRunnerPortals()
      .then((reaped) => {
        if (reaped)
          console.log(
            `[runner-portals] reaped ${reaped} orphaned Portal service(s)`,
          );
      })
      .catch((error) =>
        console.error("[runner-portals] orphan reap failed:", error),
      );
  run();
  runnerPortalReapTimer = setInterval(run, RUNNER_PORTAL_REAP_INTERVAL_MS);
  runnerPortalReapTimer.unref?.();
  console.log(
    `[runner-portals] orphan reaper started (every ${RUNNER_PORTAL_REAP_INTERVAL_MS / 60_000}m)`,
  );
}

function runnerSession(session: UnifiedSession, user?: string) {
  const target = session.runner;
  if (!target || !session.repo || !session.worktreeDir)
    throw new Error("This session does not run on a Runner.");
  const runner = getRunner(target.id);
  if (
    !runner ||
    !runnerAllowed(runner, { user, repo: session.repo, permission: "portals" })
  )
    throw new Error("This Runner is not permitted to expose Portals.");
  return {
    runner,
    target,
    repo: session.repo,
    workspacePath: session.worktreeDir,
  };
}

function parseRecord(
  value: unknown,
  session: UnifiedSession,
  user?: string,
): RunnerPortalRecord {
  const valueRecord =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const context = runnerSession(session, user);
  const name = typeof valueRecord.name === "string" ? valueRecord.name : "";
  const command =
    typeof valueRecord.command === "string" ? valueRecord.command : "";
  const port = typeof valueRecord.port === "number" ? valueRecord.port : NaN;
  if (
    !NAME.test(name) ||
    !command ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 19_000
  )
    throw new Error("Runner returned an invalid Portal record.");
  const state = [
    "starting",
    "awake",
    "sleeping",
    "waking",
    "failed",
    "stopped",
  ].includes(String(valueRecord.state))
    ? (valueRecord.state as PortalRecord["state"])
    : "failed";
  return {
    name,
    key:
      typeof valueRecord.key === "string"
        ? valueRecord.key
        : `PORTAL_${name.toUpperCase().replace(/-/g, "_")}_PORT`,
    command,
    port,
    state,
    ...(typeof valueRecord.description === "string"
      ? { description: valueRecord.description }
      : {}),
    ...(typeof valueRecord.defaultPath === "string"
      ? { defaultPath: valueRecord.defaultPath }
      : {}),
    ...(typeof valueRecord.pid === "number" ? { pid: valueRecord.pid } : {}),
    ...(typeof valueRecord.startedAt === "string"
      ? { startedAt: valueRecord.startedAt }
      : {}),
    ...(typeof valueRecord.lastError === "string"
      ? { lastError: valueRecord.lastError }
      : {}),
    runnerId: context.target.id,
    sessionId: session.id,
    repo: context.repo,
    workspacePath: context.workspacePath,
    ...(user ? { user } : {}),
  };
}

export async function startRunnerPortal(input: {
  session: UnifiedSession;
  user?: string;
  name: string;
  command: string;
  port?: number;
  description?: string;
}): Promise<RunnerPortalRecord> {
  const context = runnerSession(input.session, input.user);
  const allocation = (await requestRunnerPortal(context.target.id, {
    sessionId: input.session.id,
    repo: context.repo,
    workspacePath: context.workspacePath,
    operation: "allocate",
    user: input.user,
    payload: { port: input.port },
  })) as { port?: unknown };
  const port =
    typeof allocation.port === "number" && Number.isInteger(allocation.port)
      ? allocation.port
      : NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 19_000)
    throw new Error("Runner returned an invalid Portal port.");
  const name = input.name.trim().toLowerCase();
  if (!NAME.test(name) || !input.command.trim())
    throw new Error("Invalid Portal service.");
  const provisional: RunnerPortalRecord = {
    name,
    key: `PORTAL_${name.toUpperCase().replace(/-/g, "_")}_PORT`,
    command: input.command.trim(),
    port,
    ...(input.description?.trim()
      ? { description: input.description.trim().slice(0, 240) }
      : {}),
    state: "starting",
    runnerId: context.target.id,
    sessionId: input.session.id,
    repo: context.repo,
    workspacePath: context.workspacePath,
    ...(input.user ? { user: input.user } : {}),
  };
  const portalUrl = await ensureRelay(provisional);
  if (!portalUrl) {
    await dropRelay(provisional);
    throw new Error("Could not register the authenticated Portal route.");
  }
  try {
    const result = await requestRunnerPortal(context.target.id, {
      sessionId: input.session.id,
      repo: context.repo,
      workspacePath: context.workspacePath,
      operation: "start",
      user: input.user,
      payload: {
        name,
        command: input.command,
        port,
        portalUrl,
        ...(input.description ? { description: input.description } : {}),
      },
    });
    const record = parseRecord(result, input.session, input.user);
    upsert(record);
    await runnerPortalUrl(record);
    return record;
  } catch (error) {
    await dropRelay(provisional);
    throw error;
  }
}

export async function listRunnerPortalServices(
  session: UnifiedSession,
  user?: string,
): Promise<RunnerPortalRecord[]> {
  const context = runnerSession(session, user);
  try {
    const result = await requestRunnerPortal(context.target.id, {
      sessionId: session.id,
      repo: context.repo,
      workspacePath: context.workspacePath,
      operation: "list",
      user,
    });
    const records = Array.isArray(result)
      ? result.map((value) => parseRecord(value, session, user))
      : [];
    for (const record of records) {
      upsert(record);
      await runnerPortalUrl(record);
    }
    return records;
  } catch {
    return load()
      .portals.filter(
        (record) =>
          record.runnerId === context.target.id &&
          record.sessionId === session.id,
      )
      .map((record) => ({
        ...record,
        state: record.state === "awake" ? "sleeping" : record.state,
      }));
  }
}

export async function stopRunnerPortal(input: {
  session: UnifiedSession;
  user?: string;
  name: string;
}): Promise<RunnerPortalRecord> {
  const context = runnerSession(input.session, input.user);
  const result = await requestRunnerPortal(context.target.id, {
    sessionId: input.session.id,
    repo: context.repo,
    workspacePath: context.workspacePath,
    operation: "stop",
    user: input.user,
    payload: { name: input.name },
  });
  const record = parseRecord(result, input.session, input.user);
  upsert(record);
  await dropRelay(record);
  return record;
}

export async function restartRunnerPortal(input: {
  session: UnifiedSession;
  user?: string;
  name: string;
}): Promise<RunnerPortalRecord> {
  const context = runnerSession(input.session, input.user);
  const existing = load().portals.find(
    (record) =>
      record.runnerId === context.target.id &&
      record.sessionId === input.session.id &&
      record.name === input.name,
  );
  const portalUrl = existing ? await ensureRelay(existing) : null;
  const result = await requestRunnerPortal(context.target.id, {
    sessionId: input.session.id,
    repo: context.repo,
    workspacePath: context.workspacePath,
    operation: "restart",
    user: input.user,
    payload: { name: input.name, ...(portalUrl ? { portalUrl } : {}) },
  });
  const record = parseRecord(result, input.session, input.user);
  upsert(record);
  await runnerPortalUrl(record);
  return record;
}

export async function setRunnerPortalPath(input: {
  session: UnifiedSession;
  user?: string;
  name: string;
  path: string;
}): Promise<RunnerPortalRecord> {
  const context = runnerSession(input.session, input.user);
  const result = await requestRunnerPortal(context.target.id, {
    sessionId: input.session.id,
    repo: context.repo,
    workspacePath: context.workspacePath,
    operation: "path",
    user: input.user,
    payload: { name: input.name, path: input.path },
  });
  const record = parseRecord(result, input.session, input.user);
  upsert(record);
  return record;
}
