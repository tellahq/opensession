/**
 * Operator-only gateway memory diagnostics (memory-diagnostics.ts).
 *
 *   GET  /api/system/memory                report memory and structure sizes
 *   POST /api/system/memory/heap-snapshot  write a heap snapshot to the state dir
 *
 * Only the host operator may call these. With sign-in on that is the machine
 * principal in the owner-only web-sessions store, which `opensession memory`
 * uses; a teammate's browser session is refused. With sign-in off every
 * request is already the single local operator. The snapshot is written on the
 * server and only its path is returned: its contents never cross HTTP.
 */
import { auditAsync } from "../audit";
import {
  heapSnapshotInFlight,
  memoryDiagnostics,
  writeHeapSnapshot,
} from "../memory-diagnostics";
import { webAuthRequired } from "../web-auth";
import type { RouteContext } from "./context";

export function isHostOperator(
  ctx: Pick<RouteContext, "authUser">,
  authRequired: boolean = webAuthRequired(),
): boolean {
  return !authRequired || ctx.authUser?.automation === true;
}

const NO_STORE = { "Cache-Control": "no-store" };

export async function handleMemoryDiagnosticsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (
    path !== "/api/system/memory" &&
    path !== "/api/system/memory/heap-snapshot"
  )
    return undefined;
  if (!isHostOperator(ctx))
    return Response.json(
      { error: "Memory diagnostics are limited to the host operator." },
      { status: 403 },
    );

  if (path === "/api/system/memory") {
    if (req.method !== "GET") return undefined;
    return Response.json(
      { ...memoryDiagnostics(), heapSnapshotInFlight: heapSnapshotInFlight() },
      { headers: NO_STORE },
    );
  }

  if (req.method !== "POST") return undefined;
  try {
    const result = await writeHeapSnapshot();
    auditAsync({
      msg: "gateway_heap_snapshot_written",
      user: ctx.authUser?.name,
      path: result.path,
      bytes: result.bytes,
      duration_ms: result.durationMs,
    });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[memory-diagnostics] heap snapshot failed:", error);
    return Response.json(
      { error: `Heap snapshot failed: ${message}` },
      { status: 500, headers: NO_STORE },
    );
  }
}
