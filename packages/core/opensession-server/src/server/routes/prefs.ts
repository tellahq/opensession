/**
 * Per-user/system preferences: Web Push, warm preview templates, memory stores, pinned tabs, UI prefs, tab colors.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { frontend } from "../frontend-build";
import { getPins as getUserPins, setPins as setUserPins } from "../pins";
import { getReads as getUserReads, setReads as setUserReads } from "../reads";
import { scheduleLiveActivitySync } from "../live-activities";
import { getDrafts, MAX_DRAFT_LENGTH, upsertDraft } from "../drafts";
import {
  addSessionMemory,
  describeScope,
  forgetSessionMemory,
  listAllMemory,
  updateMemoryEntry,
} from "../session-memory";
import { getLanes as getUserLanes, setLanes as setUserLanes } from "../lanes";
import {
  getSnoozes as getUserSnoozes,
  setSnoozes as setUserSnoozes,
} from "../snoozes";
import { getHides as getUserHides, setHides as setUserHides } from "../hides";
import { mergeMapDelta, requestedMapDelta } from "../shared/map-delta";
import {
  getSettlements as getUserSettlements,
  setSettlements as setUserSettlements,
} from "../settlements";
import {
  getTabColors as getUserTabColors,
  setTabColors as setUserTabColors,
} from "../tab-colors";
import { getUiPrefs, patchUiPrefs } from "../ui-prefs";
import { getPersonalPrompt, setPersonalPrompt } from "../personal-prompts";
import {
  getPersonalOutputStyle,
  setPersonalOutputStyle,
} from "../personal-output-style";
import {
  refreshWarmTemplate,
  setWarmTemplateConfig,
  warmTemplateStatus,
} from "../warm-template";
import {
  previewPoolStatus,
  refreshGoldenImage,
  setPreviewPoolConfig,
} from "../preview-pool";
import { REPOS } from "../worktree";
import { conditionalJsonResponse } from "../http-json";

export async function handlePrefsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // ── Web Push (phone/desktop notifications, app closed) ──
  if (path === "/api/push/vapid-key" && req.method === "GET") {
    const { getVapidPublicKey } = await import("../../server/push");
    return Response.json({ publicKey: getVapidPublicKey() });
  }

  if (path === "/api/push/subscribe" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const { addPushSubscription } = await import("../../server/push");
    const result = addPushSubscription({
      user: body.user,
      subscription: body.subscription,
      userAgent: req.headers.get("user-agent") || undefined,
    });
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  if (path === "/api/push/unsubscribe" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.endpoint !== "string")
      return Response.json({ error: "endpoint required" }, { status: 400 });
    const { removePushSubscription } = await import("../../server/push");
    removePushSubscription(body.endpoint);
    return Response.json({ ok: true });
  }

  // ── Warm preview templates (per-repo prebuilt worktrees, scheduled) ──
  if (path === "/api/warm-templates" && req.method === "GET") {
    return Response.json({ repos: warmTemplateStatus() });
  }

  {
    const m = path.match(/^\/api\/warm-templates\/([^/]+)(\/refresh)?$/);
    if (m) {
      const repoId = decodeURIComponent(m[1]);
      if (!(repoId in REPOS))
        return Response.json(
          { error: `unknown repo "${repoId}"` },
          { status: 404 },
        );
      if (!m[2] && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body)
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        const patch: Record<string, unknown> = {};
        if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
        if (typeof body.intervalHours === "number" && body.intervalHours >= 1)
          patch.intervalHours = Math.floor(body.intervalHours);
        if (Array.isArray(body.warmRoutes))
          patch.warmRoutes = body.warmRoutes.filter(
            (r: unknown): r is string => typeof r === "string",
          );
        setWarmTemplateConfig(repoId, patch);
        return Response.json({ repos: warmTemplateStatus() });
      }
      if (m[2] && req.method === "POST") {
        // Fire-and-forget: a refresh boots a real dev server (minutes);
        // the UI polls GET for progress via `refreshing`.
        void refreshWarmTemplate(repoId, { force: true }).catch(() => {});
        return Response.json({ repos: warmTemplateStatus() });
      }
    }
  }

  // ── Preview pool (warm, pre-booted dev-server containers per repo) ──
  if (path === "/api/preview-pool" && req.method === "GET") {
    return Response.json({ repos: previewPoolStatus() });
  }

  {
    const m = path.match(/^\/api\/preview-pool\/([^/]+)(\/refresh)?$/);
    if (m) {
      const repoId = decodeURIComponent(m[1]);
      if (!(repoId in REPOS))
        return Response.json(
          { error: `unknown repo "${repoId}"` },
          { status: 404 },
        );
      if (!m[2] && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body)
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        const patch: Record<string, unknown> = {};
        if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
        if (typeof body.devAuthBypass === "boolean")
          patch.devAuthBypass = body.devAuthBypass;
        if (["docker", "daytona", "microvm"].includes(body.backend))
          patch.backend = body.backend;
        for (const k of [
          "running",
          "paused",
          "cpus",
          "goldenIntervalHours",
          "claimIdleMinutes",
        ] as const) {
          if (typeof body[k] === "number") patch[k] = body[k];
        }
        if (typeof body.memory === "string") patch.memory = body.memory;
        setPreviewPoolConfig(repoId, patch);
        return Response.json({ repos: previewPoolStatus() });
      }
      if (m[2] && req.method === "POST") {
        // Fire-and-forget: a golden rebuild boots a dev server (minutes);
        // the UI polls GET for progress via `goldenBuilding`. Refill the
        // warm pool right after (the rebuild retires old-image spares).
        void refreshGoldenImage(repoId, true)
          .then(() =>
            import("../preview-pool").then((p) => p.previewPoolSweepNow()),
          )
          .catch(() => {});
        return Response.json({ repos: previewPoolStatus() });
      }
    }
  }

  // ── Memory (Settings → Memory: the same repo/user/team/channel stores
  // the opensession-memory tools + Slack channel memory read/write) ──
  if (path === "/api/memory") {
    if (req.method === "GET") {
      return Response.json({
        scopes: await listAllMemory(Object.keys(REPOS)),
      });
    }
    const body = await req.json().catch(() => null);
    const scope = body?.scopeKey ? describeScope(String(body.scopeKey)) : null;
    if (!scope)
      return Response.json(
        { error: "unknown or invalid scopeKey" },
        { status: 400 },
      );
    if (req.method === "POST") {
      const text = String(body?.text || "").trim();
      if (!text)
        return Response.json({ error: "text required" }, { status: 400 });
      const entry = await addSessionMemory(
        scope,
        text,
        String(body?.by || "settings"),
      );
      return Response.json({ entry });
    }
    if (req.method === "PUT") {
      const text = String(body?.text || "").trim();
      if (!text || !body?.id)
        return Response.json(
          { error: "id and text required" },
          { status: 400 },
        );
      const entry = await updateMemoryEntry(scope.key, String(body.id), text);
      if (!entry)
        return Response.json({ error: "entry not found" }, { status: 404 });
      return Response.json({ entry });
    }
    if (req.method === "DELETE") {
      if (!body?.id)
        return Response.json({ error: "id required" }, { status: 400 });
      const res = await forgetSessionMemory([scope], String(body.id));
      if (!res.ok) return Response.json({ error: res.error }, { status: 404 });
      return Response.json({ ok: true });
    }
  }

  // ── The per-user stores below (pins, output style, personal prompt, read marks, drafts,
  // UI prefs, lanes, snoozes, hides, settlements, tab colors) all resolve WHO through
  // requestUser: the verified sign-in identity when web sign-in is active,
  // the client-claimed name otherwise. They used to read the raw `user`
  // param, which let a signed-in teammate read and overwrite another
  // person's state by typing their name into the query string.

  // ── Per-user pinned tabs ──
  // GET reads a user's pins; PUT replaces them wholesale (the frontend sends
  // the full list on every toggle and on first-load localStorage migration).
  if (path === "/api/pins" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return conditionalJsonResponse(req, { pins: getUserPins(user) });
  }

  if (path === "/api/pins" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.user !== "string" || !Array.isArray(body.pins)) {
      return Response.json(
        { error: "user (string) and pins (array) are required" },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    return Response.json({ pins: setUserPins(user, body.pins) });
  }

  // ── Per-user output style ──
  // Concise changes how interactive runs report their work, not how much work
  // they do. It shares the personal prompt's identity key so the choice follows
  // a teammate between the web, native app, Slack, and GitHub.
  if (path === "/api/personal-output-style" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return Response.json({ outputStyle: getPersonalOutputStyle(user) });
  }

  if (path === "/api/personal-output-style" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.user !== "string" ||
      (body.outputStyle !== "default" && body.outputStyle !== "concise")
    ) {
      return Response.json(
        {
          error:
            'user (string) and outputStyle ("default" or "concise") are required',
        },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    return Response.json({
      outputStyle: setPersonalOutputStyle(user, body.outputStyle),
    });
  }

  // ── Per-user personal system prompt ──
  // An extra standing-instructions block injected into every interactive run
  // the user starts (see personal-prompts.ts). Keyed through the identity
  // table, so all of a teammate's surfaces share one prompt. GET reads it;
  // PUT replaces it wholesale (empty string clears).
  if (path === "/api/personal-prompt" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return Response.json({ prompt: getPersonalPrompt(user) });
  }

  if (path === "/api/personal-prompt" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.user !== "string" ||
      typeof body.prompt !== "string"
    ) {
      return Response.json(
        { error: "user (string) and prompt (string) are required" },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    return Response.json({
      prompt: setPersonalPrompt(user, body.prompt),
    });
  }

  // ── Per-user read marks (unread flags) ──
  // The server mirror of the frontend's localStorage read state
  // (src/frontend/lib/reads.ts), so consumers that can't see localStorage —
  // the hardware macropad feed (GET /api/keypad) — can flag sessions with
  // unread activity. GET reads a user's marks; PUT replaces them wholesale
  // (the frontend pushes its full map on every mark change), same shape as pins.
  if (path === "/api/reads" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return conditionalJsonResponse(req, { reads: getUserReads(user) });
  }

  if (path === "/api/reads" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.user !== "string" ||
      !body.reads ||
      typeof body.reads !== "object"
    ) {
      return Response.json(
        { error: "user (string) and reads (object) are required" },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    const reads = setUserReads(user, body.reads);
    scheduleLiveActivitySync();
    return Response.json({ reads });
  }

  // ── Per-user unsent composer drafts ──
  // Text typed into a session's composer but not sent, so it follows you
  // between the browser and the phone (src/server/drafts.ts). This is a
  // person's private writing, and it was the first store to take the user
  // from the verified identity rather than the `user` param — the rest
  // followed. Writes are one session at a time: a whole-map
  // PUT from a client that hadn't loaded yet would wipe the other device's
  // drafts.
  if (path === "/api/drafts" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return conditionalJsonResponse(req, { drafts: getDrafts(user) });
  }

  if (path === "/api/drafts" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.sessionId !== "string" ||
      !body.sessionId ||
      typeof body.text !== "string"
    ) {
      return Response.json(
        { error: "sessionId (string) and text (string) are required" },
        { status: 400 },
      );
    }
    if (body.text.length > MAX_DRAFT_LENGTH) {
      return Response.json({ error: "Draft is too long" }, { status: 413 });
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    const candidateAt =
      typeof body.updatedAt === "string" && body.updatedAt
        ? body.updatedAt
        : new Date().toISOString();
    const parsedAt = Date.parse(candidateAt);
    if (!Number.isFinite(parsedAt)) {
      return Response.json(
        { error: "updatedAt must be an ISO timestamp" },
        { status: 400 },
      );
    }
    const updatedAt = new Date(
      Math.min(parsedAt, Date.now() + 5 * 60_000),
    ).toISOString();
    const result = upsertDraft(user, body.sessionId, body.text, updatedAt);
    return Response.json(result);
  }

  // ── Per-user UI prefs (cross-device view preferences, e.g. the turn-
  // activity fold setting). GET reads a user's map; PUT merges a patch —
  // merge, not replace, so one device can't clobber keys set on another.
  if (path === "/api/ui-prefs" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return conditionalJsonResponse(req, { prefs: getUiPrefs(user) });
  }

  if (path === "/api/ui-prefs" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.user !== "string" ||
      typeof body.prefs !== "object" ||
      body.prefs === null
    ) {
      return Response.json(
        { error: "user (string) and prefs (object) are required" },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    return Response.json({
      prefs: patchUiPrefs(user, body.prefs, body.expected),
    });
  }

  // ── Per-user sidebar lanes ──
  // Same per-user model as pins. A write is a DELTA (`set` / `remove`) so two
  // clients editing different keys stop erasing each other; see
  // shared/map-delta.ts. Older whole-map clients are accepted merge-only.
  if (path === "/api/lanes" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return conditionalJsonResponse(req, { lanes: getUserLanes(user) });
  }

  if (path === "/api/lanes" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const delta = requestedMapDelta(body, "lanes");
    if (!body || typeof body.user !== "string" || !delta) {
      return Response.json(
        { error: "user (string) and a valid set/remove delta are required" },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    const next = mergeMapDelta(getUserLanes(user), delta);
    return Response.json({ lanes: setUserLanes(user, next) });
  }

  // ── Per-user workspace snoozes ──
  // GET reads a user's snooze map; a write is a delta, for the reason in
  // shared/map-delta.ts: a whole-map PUT from a client that loaded before the
  // other device's snooze deleted it, which read as a Someday snooze waking
  // up on its own.
  if (path === "/api/snoozes" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return conditionalJsonResponse(req, { snoozes: getUserSnoozes(user) });
  }

  if (path === "/api/snoozes" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const delta = requestedMapDelta(body, "snoozes");
    if (!body || typeof body.user !== "string" || !delta) {
      return Response.json(
        { error: "user (string) and a valid set/remove delta are required" },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    const next = mergeMapDelta(getUserSnoozes(user), delta);
    return Response.json({
      snoozes: setUserSnoozes(user, next),
    });
  }

  // ── Per-user sidebar hides ──
  // The personal counterpart to archiving (which is global, see archive.ts):
  // hiding a row drops it from THIS user's sidebar while the session keeps
  // running for everyone else. Same per-user model as pins, same delta write.
  if (path === "/api/hides" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return conditionalJsonResponse(req, { hides: getUserHides(user) });
  }

  if (path === "/api/hides" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const delta = requestedMapDelta(body, "hides");
    if (!body || typeof body.user !== "string" || !delta) {
      return Response.json(
        { error: "user (string) and a valid set/remove delta are required" },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    const next = mergeMapDelta(getUserHides(user), delta);
    return Response.json({ hides: setUserHides(user, next) });
  }

  // ── Per-user workspace settlements ──
  // Settlement is personal sidebar triage, unlike global Archive. The map is
  // keyed by workspace-row identity and carries explicit Settle/Unsettle acts.
  if (path === "/api/settlements" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return conditionalJsonResponse(req, {
      settlements: getUserSettlements(user),
    });
  }

  if (path === "/api/settlements" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.user !== "string" ||
      typeof body.settlements !== "object" ||
      body.settlements === null
    ) {
      return Response.json(
        { error: "user (string) and settlements (object) are required" },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    return Response.json({
      settlements: setUserSettlements(user, body.settlements),
    });
  }

  // ── Per-user session tab colors ──
  // Same per-user model as pins: GET reads a user's tab colors; a write is a
  // delta, same as the maps above.
  if (path === "/api/tab-colors" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    return conditionalJsonResponse(req, { colors: getUserTabColors(user) });
  }

  if (path === "/api/tab-colors" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const delta = requestedMapDelta(body, "colors");
    if (!body || typeof body.user !== "string" || !delta) {
      return Response.json(
        { error: "user (string) and a valid set/remove delta are required" },
        { status: 400 },
      );
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    const next = mergeMapDelta(getUserTabColors(user), delta);
    return Response.json({
      colors: setUserTabColors(user, next),
    });
  }

  return undefined;
}
