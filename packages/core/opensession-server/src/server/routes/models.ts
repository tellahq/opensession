/**
 * Model catalog + default model + per-model default engine, sandbox capability/prewarm, branch-name suggestion, voice transcription.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import {
  KNOWN_MODELS,
  accountProviderForModel,
  getDefaultModel,
  getModelFallbackAuto,
  interactiveDefaultModel,
  modelEfforts,
  refreshPickerModels,
  setDefaultModel,
  setInteractiveDefaultModel,
  setModelFallbackAuto,
  toPiModel,
} from "../models";
import { modelProviders } from "../model-providers";
import {
  configuredInteractiveDefaultModel,
  configuredModelProviders,
  modelFitsConfiguredProviders,
  pickerModelId,
} from "../model-catalog";
import { type Sandbox } from "../sandbox";
import { suggestBranchName } from "../suggest-branch";
import { MAX_AUDIO_BYTES, transcribeAudio } from "../transcribe";
import {
  supportsOpenaiFastMode,
  supportsOpenaiUltrafast,
} from "../openai-service-tier";

const availableEngines = () => [
  { id: "pi" as const, label: "Pi", available: true },
];

export async function handleModelsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // ── Models available to sessions ──
  if (path === "/api/models" && req.method === "GET") {
    // Re-fold the pi entries from config on every fetch (cheap, tiny
    // JSON reads — same "read fresh" contract as /sandbox/status below) so a
    // config change shows up on the next picker open, not the next restart.
    refreshPickerModels();
    const configuredProviders = configuredModelProviders();
    // One list of Pi models. Native claude/codex ids stay resolvable for
    // stored sessions, just not selectable here. Guard: with no engine
    // configured, fall back to the full registry so the picker is never empty.
    const engineModels = KNOWN_MODELS.filter((m) => m.provider === "pi");
    const engineConfigured = engineModels.length > 0;
    const visibleModels = (
      engineConfigured ? engineModels : KNOWN_MODELS
    ).filter((model) =>
      modelFitsConfiguredProviders(model.id, configuredProviders),
    );
    const interactiveDefault = engineConfigured
      ? configuredInteractiveDefaultModel(configuredProviders)
      : getDefaultModel();
    // One provider config read for the whole catalog, not one per model.
    const providers = modelProviders();
    const catalogModels = visibleModels.map((model) => ({
      ...model,
      efforts: modelEfforts(model.id, providers),
      accountProvider: accountProviderForModel(model.id),
      fastModeSupported: supportsOpenaiFastMode(toPiModel(model.id)),
      ultrafastSupported: supportsOpenaiUltrafast(toPiModel(model.id)),
    }));
    const routedDefault = pickerModelId(interactiveDefault);
    const catalogDefault = catalogModels.some(
      (model) => model.id === routedDefault,
    )
      ? routedDefault
      : catalogModels[0]?.id || routedDefault;
    return Response.json({
      models: catalogModels,
      default: catalogDefault,
      autoFallback: getModelFallbackAuto(),
      // The engines a model can be routed to, and which of them are ready
      // to run: the composer's Engine choice composes the engine's prefix
      // onto whatever model is selected (models.ts routeModel).
      engines: availableEngines(),
      // Per-model default engine, keyed by the engine-stripped base id.
      modelEngines: {},
    });
  }

  // Audit-backed real-work scorecard. This is evidence for the human
  // sandbox-default decision, never an automatic config mutation.
  if (path === "/api/sandbox/scorecard" && req.method === "GET") {
    const requested = Number(url.searchParams.get("days") || 30);
    const days = Number.isFinite(requested)
      ? Math.min(90, Math.max(1, Math.floor(requested)))
      : 30;
    const { readSandboxScorecard } = await import("../sandbox/scorecard");
    return Response.json(readSandboxScorecard(days));
  }

  // Warm-on-typing sandbox prewarm (src/server/sandbox/prewarm.ts):
  // the New-session palette POSTs {provider, repo, user} on the first
  // keystroke (and ~every 60s while typing) with a REMOTE provider
  // selected, so the 30-45s runner bootstrap runs while the prompt is
  // being written; the create's ensure() then ADOPTS the warmed
  // sandbox. Cheap + idempotent (a live prewarm is just TTL-touched),
  // rate-limited per user, and validation lives in requestPrewarm —
  // unknown provider/repo answer {state:"unsupported"}, no-remote
  // setups {state:"disabled"}. Frontend swallows every failure.
  if (path === "/api/sandbox/prewarm" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const provider = typeof body?.provider === "string" ? body.provider : "";
    const repoId = typeof body?.repo === "string" ? body.repo : "";
    const user = requestUser(ctx, body?.user) || "anon";
    const { requestPrewarm, prewarmRateLimited } =
      await import("../../server/sandbox/prewarm");
    if (prewarmRateLimited(user)) {
      return Response.json({ state: "rate-limited" }, { status: 429 });
    }
    return Response.json(await requestPrewarm(provider, repoId, user));
  }

  // Toggle interactive auto model-switch (manual vs auto) on running out
  // of credits. { auto: boolean }.
  if (path === "/api/models/auto-fallback" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.auto !== "boolean") {
      return Response.json(
        { error: "auto (boolean) is required" },
        { status: 400 },
      );
    }
    return Response.json({
      autoFallback: setModelFallbackAuto(body.auto),
    });
  }

  // Suggest a branch name from a task prompt (one no-tools Haiku call).
  // Used to auto-fill the New Session "Branch name" field as you type.
  if (path === "/api/suggest-branch" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    const branch = await suggestBranchName(prompt);
    return Response.json({ branch });
  }

  // Voice dictation: raw audio body (whatever MediaRecorder produced) in,
  // transcribed text out. Providers chain in src/server/transcribe.ts —
  // hosted keys when configured, local whisper.cpp otherwise.
  if (path === "/api/transcribe" && req.method === "POST") {
    try {
      const audio = await req.blob();
      if (audio.size === 0) {
        return Response.json({ error: "empty audio" }, { status: 400 });
      }
      if (audio.size > MAX_AUDIO_BYTES) {
        return Response.json({ error: "audio too large" }, { status: 413 });
      }
      const mime = req.headers.get("content-type") || "audio/webm";
      const result = await transcribeAudio(audio, mime);
      return Response.json(result);
    } catch (e: any) {
      console.error("[transcribe]", e);
      return Response.json(
        { error: e?.message || "transcription failed" },
        { status: 500 },
      );
    }
  }

  // Set (or clear, with model:null) the default model new sessions run on.
  if (path === "/api/models/default" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    // Two independent knobs: `model` = the global default (Slack/Linear/
    // Plain loops, workflows); `interactiveModel` = what NEW interactive
    // sessions start on (the composer's preselected row).
    if (!body || (!("model" in body) && !("interactiveModel" in body))) {
      return Response.json(
        {
          error: "model or interactiveModel is required (id, or null to clear)",
        },
        { status: 400 },
      );
    }
    try {
      if ("model" in body) {
        setDefaultModel(body.model ?? null);
        // The Settings control is the default for new sessions too. Keep the
        // historic interactive override only when an API caller explicitly
        // supplies one, so the two defaults cannot silently diverge.
        if (!("interactiveModel" in body))
          setInteractiveDefaultModel(body.model ?? null);
      }
      if ("interactiveModel" in body)
        setInteractiveDefaultModel(body.interactiveModel ?? null);
      return Response.json({
        default: getDefaultModel(),
        interactiveDefault: interactiveDefaultModel(),
      });
    } catch (e: any) {
      return Response.json(
        { error: e?.message || "Failed to set default model" },
        { status: 400 },
      );
    }
  }

  return undefined;
}
