/**
 * Health check, macropad keypad feed, in-process frontend rebuild, HTTP upload staging, audit-log viewer.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { type RouteContext, requestUser } from "./context";
import { activeAgentRunCount } from "../agent-runner";
import { getAgents } from "../agents-registry";
import { configuredServer } from "../config";
import {
  IS_DEV,
  buildFrontend,
  frontend,
  isPrebuiltFrontend,
  sharedCheckoutEditors,
} from "../frontend-build";
import { getPins } from "../pins";
import { getReads, isUnread } from "../reads";
import { invalidateSessionsCache, runErrors } from "../session-cache";
import { getSessionControl } from "../session-control";
import { MAX_UPLOAD_BYTES, stageHttpUpload } from "../uploads";
import { systemStats } from "../system-stats";
import { BOOT_ID, broadcastToAll, broadcastToSession } from "../ws-hub";
import {
  executorClientHealth,
  executorClientReadinessSnapshot,
} from "../executor-client";
import {
  discardSessionDeadOutbox,
  discardSessionDeadTimer,
  releaseSessionQuarantine,
  retrySessionDeadOutbox,
  retrySessionDeadTimer,
  sessionKernelDeadLetters,
  sessionKernelHealth,
  sessionKernelReadinessSnapshot,
} from "../session-kernel";
import { requireWorkspaceAdmin } from "../workspace-auth";
import { audit } from "../audit";
import { serviceReadiness } from "../service-readiness";
import { runtimeGeneration } from "../runtime-generation";

// The listing is served from catalog state only. Keep a short-TTL snapshot with
// single-flight refresh so repeated reliability-panel polling is cheap even
// when the catalog is degraded; mutations invalidate it immediately.
const DEAD_LETTERS_CACHE_TTL_MS = 5_000;
const RUNTIME_GENERATION = runtimeGeneration();
type DeadLettersEntry = {
  at: number;
  inFlight?: Promise<unknown>;
  value?: unknown;
};
const deadLettersCaches = new Map<string, DeadLettersEntry>();

/** Test access to cache timing state without fake timers. */
export function __deadLettersCachesForTest(): Map<string, DeadLettersEntry> {
  return deadLettersCaches;
}

export function deadLettersSnapshot(
  limit: number,
  offset: number,
  load: (limit: number, offset: number) => unknown = () =>
    sessionKernelDeadLetters(limit, offset),
): Promise<unknown> {
  // One entry per page: a cached page A must never be served for page B.
  const key = `${limit}:${offset}`;
  const now = Date.now();
  const cached = deadLettersCaches.get(key);
  if (cached && now - cached.at < DEAD_LETTERS_CACHE_TTL_MS) {
    if (cached.inFlight) return cached.inFlight;
    if (cached.value !== undefined) return Promise.resolve(cached.value);
  }
  // The last settled value is retained across refreshes so a degraded actor
  // cannot take the reliability view down with it.
  const entry: DeadLettersEntry = {
    at: now,
    ...(cached?.value !== undefined ? { value: cached.value } : {}),
  };
  const inFlight = (async () => {
    try {
      const value = await Promise.resolve(load(limit, offset));
      entry.value = value;
      entry.at = Date.now();
      return value;
    } catch (error) {
      // Rate-limit retry attempts while the actor keeps failing.
      entry.at = Date.now();
      if (entry.value === undefined) throw error;
      return entry.value;
    } finally {
      entry.inFlight = undefined;
    }
  })();
  entry.inFlight = inFlight;
  deadLettersCaches.set(key, entry);
  return inFlight;
}

export async function handleSystemRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  if (path === "/api/system/session-kernel/dead-letters") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    if (req.method === "GET") {
      const limit = Math.max(
        1,
        Math.min(100, Math.trunc(Number(url.searchParams.get("limit"))) || 100),
      );
      const offset = Math.max(
        0,
        Math.trunc(Number(url.searchParams.get("offset"))) || 0,
      );
      return Response.json(await deadLettersSnapshot(limit, offset));
    }
    if (req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        type?: unknown;
        sessionId?: unknown;
        timerId?: unknown;
        id?: unknown;
        action?: unknown;
      } | null;
      const validDeadLetterAction =
        body?.action === "retry" || body?.action === "discard";
      const validTimer =
        validDeadLetterAction &&
        body?.type === "timer" &&
        typeof body.sessionId === "string" &&
        body.sessionId.trim().length > 0 &&
        typeof body.timerId === "string" &&
        body.timerId.trim().length > 0 &&
        body.id === undefined;
      const validOutbox =
        validDeadLetterAction &&
        body?.type === "outbox" &&
        Number.isSafeInteger(body.id) &&
        Number(body.id) > 0 &&
        body.sessionId === undefined &&
        body.timerId === undefined;
      const validQuarantine =
        body?.type === "quarantine" &&
        body.action === "release" &&
        typeof body.sessionId === "string" &&
        body.sessionId.trim().length > 0 &&
        body.timerId === undefined &&
        body.id === undefined;
      if (!validTimer && !validOutbox && !validQuarantine)
        return Response.json(
          { error: "invalid_dead_letter_action" },
          { status: 400 },
        );
      const discard = body.action === "discard";
      const changed = await (validQuarantine
        ? releaseSessionQuarantine(body.sessionId as string)
        : validTimer
          ? discard
            ? discardSessionDeadTimer(
                body.sessionId as string,
                body.timerId as string,
              )
            : retrySessionDeadTimer(
                body.sessionId as string,
                body.timerId as string,
              )
          : discard
            ? discardSessionDeadOutbox(Number(body.id))
            : retrySessionDeadOutbox(Number(body.id)));
      audit({
        msg: "session_kernel_dead_letter_changed",
        user: requestUser(ctx),
        action: validQuarantine ? "release" : discard ? "discard" : "retry",
        kind: body?.type,
        session_id:
          typeof body?.sessionId === "string" ? body.sessionId : undefined,
        timer_id: typeof body?.timerId === "string" ? body.timerId : undefined,
        outbox_id: Number.isSafeInteger(body?.id)
          ? Number(body?.id)
          : undefined,
        changed,
      });
      if (changed) {
        deadLettersCaches.clear();
        if (validQuarantine) {
          invalidateSessionsCache();
          broadcastToSession(body.sessionId as string, {
            type: "session_status",
            sessionId: body.sessionId,
            isRunning: false,
          });
        }
      }
      return Response.json(
        {
          changed,
          action: validQuarantine ? "release" : discard ? "discard" : "retry",
        },
        { status: changed ? 200 : 404 },
      );
    }
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, POST" },
    });
  }

  if (path === "/live" && req.method === "GET")
    return Response.json({
      ok: true,
      bootId: BOOT_ID,
      uptime: process.uptime(),
    });

  if (path === "/ready" && req.method === "GET") {
    try {
      const kernel = sessionKernelReadinessSnapshot();
      const executor = executorClientHealth();
      const executorReadiness = executorClientReadinessSnapshot();
      const readiness = serviceReadiness();
      // This is the only gateway node. Keep serving the UI while a worker
      // lane is degraded; launches themselves still fail closed.
      const ready = readiness.phase === "ready";
      return Response.json(
        {
          ok: ready,
          ready,
          phase: readiness.phase,
          bootId: BOOT_ID,
          generation: RUNTIME_GENERATION,
          activeRuns: activeAgentRunCount(),
          executor: { ...executor, ...executorReadiness },
          sessionKernel: kernel,
        },
        { status: ready ? 200 : 503 },
      );
    } catch (error) {
      return Response.json(
        {
          ok: false,
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 503 },
      );
    }
  }

  // Health check (includes agent health — Tailscale-only, not public).
  // frontendVersion lets clients detect a frontend-only rebuild (no bootId
  // change) and refresh.
  if (path === "/api/health") {
    if (url.searchParams.get("brief") === "1") {
      return Response.json({
        ok: true,
        bootId: BOOT_ID,
        frontendVersion: frontend?.version ?? null,
      });
    }
    const agentHealth: Record<string, unknown> = {};
    for (const a of getAgents()) {
      agentHealth[a.name] = a.health();
    }
    return Response.json({
      ok: true,
      bootId: BOOT_ID,
      frontendVersion: frontend?.version ?? null,
      uptime: process.uptime(),
      // In-flight runner runs this process is driving — a drain-aware deploy
      // polls this to restart only when the service is idle (or near it), so a
      // restart kills as few in-flight runs/background tasks as possible.
      activeRuns: activeAgentRunCount(),
      executor: executorClientHealth(),
      sessionKernel: await sessionKernelHealth(),
      agents: agentHealth,
      system: systemStats(),
    });
  }

  // ── Macropad status feed ──
  // A user's pinned sessions (pinned order, max 8) with a coarse status per
  // key, for a hardware keypad. Polled ~every 1.5s, so it only touches
  // in-memory state: the per-user pins file plus the 2s session cache behind
  // SessionControl. The central auth gate accepts either a signed-in web
  // session or the route-scoped KEYPAD_TOKEN bearer credential.
  if (path === "/api/keypad" && req.method === "GET") {
    const user = url.searchParams.get("user") || "Anonymous";
    const control = getSessionControl();
    // Per-user read marks (mirrored from the app's localStorage — reads.ts),
    // so a finished session with activity newer than the last-read mark shows
    // as unread on the macropad.
    const reads = getReads(user);
    // Canonical open-in-app link per session (the macropad opens it on
    // keypress) — same shape as the frontend's session path helper (share-link.ts):
    // workspace-scoped when the session belongs to a Project.
    const uiBase = configuredServer().publicBaseUrl;
    const sessions: Array<{
      id: string;
      title: string;
      status: "idle" | "working" | "needs_input" | "unread" | "error";
      url: string;
    }> = [];
    for (const key of getPins(user)) {
      if (sessions.length >= 8) break;
      // Pins also hold workspace rows (`workspace:<id>`) — not sessions.
      if (key.startsWith("workspace:")) continue;
      const s = control.getSession(key);
      if (!s || s.state === "archived") continue;
      // A queued prompt means the session is about to run — show it as
      // working, same as taskStateOf (sessions-tools.ts). An engine session
      // id means it has run before, so an idle session with one is "done";
      // without one it's a fresh pinned session that never ran.
      const lastRunError = runErrors.get(s.id) || s.lastRunError;
      // Precedence (first match wins) — surface the single most important
      // thing: error > working > needs_input > unread > idle. The old "done"
      // (finished, has run before) collapses into idle; "unread" is the
      // finished-with-new-activity case (lastActivity newer than the user's
      // read mark). See src/server/reads.ts.
      const status: "idle" | "working" | "needs_input" | "unread" | "error" =
        lastRunError
          ? "error"
          : s.state === "running" || s.state === "queued"
            ? "working"
            : s.state === "waiting_question"
              ? "needs_input"
              : isUnread(s.lastActivity, reads[s.id])
                ? "unread"
                : "idle";
      const sessionUrl = s.workspaceId
        ? `${uiBase}/workspace/${encodeURIComponent(s.workspaceId)}/session/${encodeURIComponent(s.id)}`
        : `${uiBase}/session/${encodeURIComponent(s.id)}`;
      sessions.push({
        id: s.id,
        title: s.title || "Untitled",
        status,
        url: sessionUrl,
      });
    }
    return Response.json({ sessions });
  }

  // Rebuild the frontend bundle in-process (no restart → live runs untouched).
  // Drop-in replacement for `systemctl restart opensession` after a frontend/CSS
  // change. Tailscale + team gated at the network layer like every route here.
  if (path === "/api/rebuild-frontend" && req.method === "POST") {
    if (IS_DEV || !frontend) {
      return Response.json(
        { ok: false, error: "not available in dev mode" },
        { status: 400 },
      );
    }
    if (isPrebuiltFrontend()) {
      return Response.json(
        { ok: false, error: "not available for a prebuilt release" },
        { status: 400 },
      );
    }
    try {
      const version = await buildFrontend();
      // Attribute the refresh nudge: the signed-in caller when web auth is
      // on, else the session(s) active in this checkout (curl from a run).
      const by = requestUser(ctx) || sharedCheckoutEditors(true);
      broadcastToAll({
        type: "frontend_updated",
        version,
        ...(by ? { by } : {}),
      });
      return Response.json({ ok: true, version });
    } catch (e) {
      return Response.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }

  // Forced client reload (mirror retirement / protocol-break deploys): nudge
  // every connected tab onto the CURRENT bundle. With `force` (the default)
  // new-enough bundles auto-reload after a short client-side grace
  // (UpdatePill.tsx; hidden tabs immediately) — bundles older than that
  // handler just show the normal update pill, which is the best a broadcast
  // can do for them. Does NOT rebuild; POST /api/rebuild-frontend first if
  // the bundle itself changed. Team gated by the global auth layer like
  // every /api/* route. Body: { force?: boolean } (default true).
  if (path === "/api/admin/frontend-reload" && req.method === "POST") {
    if (IS_DEV || !frontend) {
      return Response.json(
        { ok: false, error: "not available in dev mode" },
        { status: 400 },
      );
    }
    let body: { force?: unknown } = {};
    try {
      body = ((await req.json()) ?? {}) as typeof body;
    } catch {
      // empty/non-JSON body → defaults
    }
    const force = body.force !== false;
    const by = requestUser(ctx) || sharedCheckoutEditors(true);
    console.log(
      `[frontend] admin reload broadcast${force ? " (forced)" : ""}${by ? ` by ${by}` : ""} (v=${frontend.version})`,
    );
    broadcastToAll({
      type: "frontend_updated",
      version: frontend.version,
      ...(force ? { force: true } : {}),
      ...(by ? { by } : {}),
    });
    return Response.json({ ok: true, version: frontend.version, force });
  }

  // Transcript v2 backfill (docs/transcripts.md §8): migrate legacy
  // session transcripts into transcripts.db, in-process (invariant 8: the
  // live server is the DB's only writer — never a standalone script). Team
  // gated by the global auth layer like every /api/* route. Body:
  // { limit?, dryRun?, wait? }. Idempotent (store imports are upserts), so
  // it's also safe to run pre-activation to warm the store. A full run takes
  // minutes (paced), so it defaults to background + immediate 202; pass
  // `wait: true` (with a small `limit`) to block for the summary.
  if (path === "/api/admin/transcript-backfill" && req.method === "POST") {
    let body: { limit?: unknown; dryRun?: unknown; wait?: unknown } = {};
    try {
      body = ((await req.json()) ?? {}) as typeof body;
    } catch {
      // empty/non-JSON body → defaults
    }
    const opts = {
      limit:
        typeof body.limit === "number" && body.limit > 0
          ? Math.floor(body.limit)
          : undefined,
      dryRun: body.dryRun === true,
    };
    const by = requestUser(ctx);
    console.log(
      `[transcript-backfill] admin trigger${by ? ` by ${by}` : ""}:`,
      opts,
    );
    const { runTranscriptBackfill } = await import("../transcript-backfill");
    if (body.wait === true) {
      const summary = await runTranscriptBackfill(opts);
      return Response.json({ ok: true, ...summary });
    }
    void runTranscriptBackfill(opts).catch((e) => {
      console.error("[transcript-backfill] admin-triggered run failed:", e);
    });
    return Response.json({ ok: true, started: true, ...opts }, { status: 202 });
  }

  // Pi engine smoke turn: one scripted turn against a throwaway
  // `os-test-pi-*` session through the in-process pi SDK runner, for
  // post-restart verification (SDK turn → bridge → transcripts.db rows).
  // Config-gated (~/.opensession-pi.json), not env-gated: with the engine
  // disabled (or dryRun: true) this never touches the bridge or the SDK —
  // it returns ok:false + reason (200), never a 500. Real turns are
  // wall-capped at 120s by the harness (under Bun.serve's 240s idleTimeout),
  // so the route can block for the result without hanging.
  if (path === "/api/admin/pi-smoke" && req.method === "POST") {
    let body: { dryRun?: unknown; model?: unknown } = {};
    try {
      body = ((await req.json()) ?? {}) as typeof body;
    } catch {
      // empty/non-JSON body → defaults
    }
    const dryRun = body.dryRun === true;
    const model = typeof body.model === "string" ? body.model : undefined;
    const by = requestUser(ctx);
    console.log(
      `[pi-smoke] admin trigger${by ? ` by ${by}` : ""}${dryRun ? " (dry-run)" : ""}`,
    );
    try {
      // Dynamic import: the pi runner's module graph (pi-runner and
      // friends) stays out of this hot route file; the heavy pi SDK import
      // is itself dynamic inside the runner.
      const { runPiSmokeTurn } = await import("../pi-runner");
      const result = await runPiSmokeTurn({
        dryRun,
        timeoutMs: 120_000,
        model,
      });
      // Snippet, not the full turn output — this is a wiring probe.
      return Response.json({ ...result, text: result.text.slice(0, 400) });
    } catch (e) {
      return Response.json(
        { ok: false, error: String((e as Error)?.message || e) },
        { status: 500 },
      );
    }
  }

  // Stream a large composer attachment straight to disk (base64-over-WS
  // can't carry big files). Body is the raw file bytes; filename in the
  // `x-file-name` header. Returns { name, path } the client echoes back in
  // its next prompt/create_session `files` entry.
  if (path === "/api/upload" && req.method === "POST") {
    try {
      const rawName = req.headers.get("x-file-name") || "file";
      const name = decodeURIComponent(rawName);
      const len = Number(req.headers.get("content-length") || 0);
      if (len > MAX_UPLOAD_BYTES) {
        return Response.json(
          {
            ok: false,
            error: `File too large (${len} bytes, max ${MAX_UPLOAD_BYTES}).`,
          },
          { status: 413 },
        );
      }
      const staged = await stageHttpUpload(name, req);
      return Response.json({ ok: true, ...staged });
    } catch (e) {
      return Response.json(
        { ok: false, error: String((e as Error)?.message || e) },
        { status: 400 },
      );
    }
  }

  // ── Audit digest: one day rolled up for the nightly Dreaming automation ──
  // The raw jsonl is 10-20MB (too big to shell-process), so this rolled-up
  // endpoint is that run's window into yesterday's work — like /api/health for
  // the health monitor. Default date is yesterday (UTC). Use `?section=` to
  // pull individual detail sections under the engine's tool-output cap.
  if (path === "/api/audit/digest" && req.method === "GET") {
    const { buildAuditDigest, listAuditDates } =
      await import("../../server/audit");
    const date =
      url.searchParams.get("date") ||
      new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const digestJson = buildAuditDigest(date);
    if (!digestJson) {
      return Response.json(
        {
          ok: false,
          error: `no audit log for ${date}`,
          dates: listAuditDates().slice(0, 7),
        },
        { status: 404 },
      );
    }
    // Join automation runs so automation sessions carry a readable name.
    const { listAutomations } = await import("../automations");
    const automationRuns: Array<Record<string, unknown>> = [];
    const nameBySession = new Map<string, string>();
    for (const a of listAutomations()) {
      for (const r of a.runs || []) {
        if (String(r.at).slice(0, 10) !== date) continue;
        automationRuns.push({
          automation: a.name,
          at: r.at,
          trigger: r.trigger,
          status: r.status,
          durationMs: r.durationMs,
          sessionId: r.sessionId,
        });
        if (r.sessionId) nameBySession.set(r.sessionId, a.name);
      }
    }
    for (const s of digestJson.sessions as Array<Record<string, unknown>>) {
      const name = nameBySession.get(String(s.id));
      if (name) s.automation = name;
    }
    const full: Record<string, unknown> = {
      ok: true,
      ...digestJson,
      automationRuns,
    };
    // The full digest is 50-70KB, which trips the engine's large-tool-output
    // truncation (the body spills to a file and the inline view is cut). A
    // `?section=errorGroups,sessions` filter lets a caller pull one or two
    // detail sections at a time, each small enough to land inline. `ok`,
    // `date` and a `sections` index of what's available always ride along.
    const section = url.searchParams.get("section");
    if (section) {
      const want = new Set(
        section
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const picked: Record<string, unknown> = {
        ok: true,
        date,
        sections: Object.keys(full).filter((k) => k !== "ok"),
      };
      for (const k of want) if (k in full) picked[k] = full[k];
      return Response.json(picked);
    }
    return Response.json(full);
  }

  // ── Audit log viewer (Settings → Audit log) ──
  if (path === "/api/audit" && req.method === "GET") {
    const { listAuditDates, readAuditEvents } =
      await import("../../server/audit");
    const date = url.searchParams.get("date") || "";
    const dates = listAuditDates();
    if (!date) return Response.json({ dates });
    return Response.json({
      dates,
      ...readAuditEvents({
        date,
        q: url.searchParams.get("q") || undefined,
        type: url.searchParams.get("type") || undefined,
        session: url.searchParams.get("session") || undefined,
        significantOnly: url.searchParams.get("all") !== "1",
        offset: Number(url.searchParams.get("offset")) || 0,
        limit: Number(url.searchParams.get("limit")) || 200,
      }),
    });
  }

  return undefined;
}
