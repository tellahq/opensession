/**
 * Setup routes — what the Settings → Setup page renders and writes.
 *
 * GET /api/setup/status stays the read-only snapshot. The write endpoints
 * (integrations env/enable, GitHub auth settings, team CRUD, repo clone +
 * register, self-restart) implement web-based instance configuration:
 * secrets go to the env file (~/.opensession.env — the systemd
 * EnvironmentFile, shared with the CLI; env-file-edit.ts), everything else
 * to config.json, all serialized under the shared config mutation lock
 * (config-mutation.ts).
 *
 * AUTHZ: the global web-auth gate in opensession.ts is the authorization —
 * when GitHub web sign-in is active every /api/* request already
 * 401s without a signed-in team member, and these paths are NOT in the
 * gate's exempt list. No route here does its own auth.
 *
 * SECURITY: responses carry presence booleans only — never an env value or
 * the OAuth client secret in any form; audit events name keys, never values.
 * Env writes are restricted to the keys an integration declares in its
 * registry spec (plus its enable flag) — arbitrary names (PATH, LD_PRELOAD…)
 * are rejected before anything touches the file.
 */

import { audit } from "../audit";
import type { IntegrationSpec } from "../integrations/registry";
import { requireWorkspaceAdmin } from "../workspace-auth";
import type { RouteContext } from "./context";
import { handleSetupCodestorageRoutes } from "./setup-codestorage";
import { handleSetupRepoRoutes } from "./setup-repos";
import { handleSetupTeamRoutes } from "./setup-team";

/** One integration's status snapshot. `envValues` (the env FILE's active
 *  definitions) overrides process.env presence so a response issued right
 *  after a write shows the truth — process.env lags the file until restart. */
async function integrationSnapshot(
  spec: IntegrationSpec,
  envValues?: Record<string, string>,
) {
  const { isEnabled } = await import("../integrations/load");
  const { configuredIntegration } = await import("../config");
  const present = (name: string): boolean =>
    envValues && name in envValues
      ? envValues[name] !== ""
      : !!process.env[name];
  const env = spec.env.map((e) => ({
    name: e.name,
    required: !!e.required,
    description: e.description,
    present: present(e.name),
  }));
  // Registry links are static; instance-dependent ones are computed here.
  const links = [...(spec.links ?? [])];
  if (spec.id === "grafana") {
    const grafanaUrl = (envValues?.GRAFANA_URL || process.env.GRAFANA_URL || "")
      .trim()
      .replace(/\/$/, "");
    if (grafanaUrl) {
      links.unshift({
        label: "Service accounts on your Grafana",
        url: `${grafanaUrl}/org/serviceaccounts`,
      });
    }
  }
  if (spec.id === "github") {
    const org = await primaryGithubOrg();
    if (org) {
      links.push({
        label: `Org webhooks (${org})`,
        url: `https://github.com/organizations/${org}/settings/hooks`,
      });
    }
  }
  // Post-write truth for `enabled`, mirroring isEnabled()'s env-wins rule
  // against the file's flag value instead of the stale process.env one.
  const enabled = envValues
    ? spec.enableFlag in envValues
      ? envValues[spec.enableFlag] === "true"
      : configuredIntegration(spec.id).enabled === true
    : isEnabled(spec);
  return {
    id: spec.id,
    label: spec.label,
    doc: spec.doc,
    enabled,
    env,
    links,
    missingRequired: env
      .filter((e) => e.required && !e.present)
      .map((e) => e.name),
  };
}

/** The GitHub org this instance mostly lives in — the modal owner across the
 *  registered repos' ghRepo values. Drives org-scoped deep links (App
 *  creation, org webhooks); absent when no repo names a GitHub owner. */
async function primaryGithubOrg(): Promise<string | undefined> {
  const { configuredRepos } = await import("../config");
  const counts = new Map<string, number>();
  for (const repo of Object.values(configuredRepos())) {
    const owner = repo.ghRepo?.split("/")[0];
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

async function githubSnapshot() {
  const { githubConnectionState } = await import("../github-connection-state");
  const state = githubConnectionState();
  const { settings: github, personalAccount } = state;
  const org = await primaryGithubOrg();
  return {
    userPrAuth: github.enabled,
    clientIdConfigured: !!github.clientId,
    clientSecretConfigured: !!github.clientSecret,
    botTokenPresent: !!process.env.GITHUB_API_TOKEN,
    connectAvailable: state.connectAvailable,
    webAuthRequired: !state.simpleMode,
    connectedLogin: personalAccount?.needsReconnect ? null : personalAccount?.login ?? null,
    needsReconnect: personalAccount?.needsReconnect === true,
    // Captured install/app-setup intent: the org the App is owned by, and
    // whether connecting should turn on per-user sign-in. Both are inert until
    // the simple-mode connect handler consumes authOnConnect.
    appOrg: state.appOrg,
    authOnConnect: state.authOnConnect,
    appCreateUrl: org
      ? `https://github.com/organizations/${org}/settings/apps/new`
      : "https://github.com/settings/apps/new",
  };
}

/** Single-line string ≤4096 chars (shared with env values). */
async function validateSetting(value: unknown): Promise<string | null> {
  const { validateEnvValue } = await import("../env-file-edit");
  return validateEnvValue(value);
}

/**
 * Is THIS process under a service manager that will bring it back after a
 * SIGTERM? Not "does this box have systemd" — a foreground `bun run
 * opensession.ts` on a systemd box is exactly the case that must say no.
 *
 * Only positive, manager-set markers count: `INVOCATION_ID` (systemd sets it
 * per unit start) and `XPC_SERVICE_NAME` (launchd sets it to the job label;
 * plain shells get "0" or nothing). Parentage is deliberately NOT used — a
 * `nohup … &` server is orphaned to pid 1 and would read as supervised, which
 * is precisely the operator this guard exists to protect. Erring toward
 * "unsupervised" costs one manual restart; erring the other way kills someone's
 * only instance from a button labelled Restart.
 */
function processIsSupervised(): boolean {
  const xpc = process.env.XPC_SERVICE_NAME;
  return !!process.env.INVOCATION_ID || (!!xpc && xpc !== "0");
}

// Restart-pending flag on globalThis so a duplicate POST (or a hot reload
// between POST and SIGTERM) stays idempotent.
const restartState: { pending: boolean } = ((globalThis as any)
  .__osSetupRestartState ??= { pending: false });

export async function handleSetupRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (!path.startsWith("/api/setup/")) return undefined;

  const forbidden = requireWorkspaceAdmin(ctx);
  if (forbidden) return forbidden;

  if (path === "/api/setup/status" && req.method === "GET") {
    const { configuredServer, configuredRepos, configuredIdentity } =
      await import("../config");
    const { INTEGRATIONS } = await import("../integrations/registry");
    // The env FILE, not process.env: a credential saved via PUT must keep
    // reading as present on every later status refetch, not flap back to
    // missing until the restart happens.
    const { readEnvFileValues } = await import("../env-file-edit");
    const { repoLifecycle } = await import("../preview");
    const { engineStatus } = await import("../engine-status");
    const envValues = readEnvFileValues();

    const publicBaseUrl = configuredServer().publicBaseUrl.replace(/\/$/, "");

    return Response.json({
      publicBaseUrl,
      repos: Object.values(configuredRepos()).map((r) => ({
        id: r.id,
        label: r.label,
        path: r.repo,
        // Can sessions in this repo provision and boot themselves? Read off
        // the main checkout — worktrees carry the same committed files.
        lifecycle: {
          ...repoLifecycle(r.repo),
          previewCommand: !!r.previewCommand,
        },
      })),
      team: (() => {
        const team = configuredIdentity().team;
        return { count: team.length, names: team.map((m) => m.name) };
      })(),
      // The only non-optional component, and the one this page used to omit —
      // a checklist that went all-green on an instance that couldn't run a turn.
      engine: engineStatus(),
      github: await githubSnapshot(),
      // `always` entries self-gate and need no setup, so they are not
      // presented as onboarding steps.
      integrations: await Promise.all(
        INTEGRATIONS.filter((spec) => !spec.always).map((spec) =>
          integrationSnapshot(spec, envValues),
        ),
      ),
    });
  }

  // ── PUT /api/setup/integrations/:id — credentials + enable flag ──────────
  const integrationMatch = path.match(
    /^\/api\/setup\/integrations\/([^/]+)$/,
  );
  if (integrationMatch && req.method === "PUT") {
    const { findIntegration } = await import("../integrations/registry");
    const spec = findIntegration(decodeURIComponent(integrationMatch[1]));
    if (!spec || spec.always) {
      return Response.json({ error: "Unknown integration" }, { status: 404 });
    }
    const body = (await req.json().catch(() => null)) as {
      enabled?: unknown;
      env?: unknown;
    } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
    const envBody =
      body.env === undefined
        ? {}
        : body.env && typeof body.env === "object" && !Array.isArray(body.env)
          ? (body.env as Record<string, unknown>)
          : null;
    if (!envBody) {
      return Response.json({ error: "env must be an object" }, { status: 400 });
    }
    // Injection guard: only the keys this integration DECLARES may be
    // written. Anything else — PATH, HOME, another integration's key — 400s.
    const allowedKeys = new Set(spec.env.map((e) => e.name));
    const edits: Record<string, string> = {};
    for (const [key, value] of Object.entries(envBody)) {
      if (!allowedKeys.has(key)) {
        return Response.json(
          { error: `Unknown env key for ${spec.id}: ${key}` },
          { status: 400 },
        );
      }
      const invalid = await validateSetting(value);
      if (invalid) {
        return Response.json({ error: `${key}: ${invalid}` }, { status: 400 });
      }
      edits[key] = value as string;
    }
    if (enabled !== undefined) {
      // Onboarding writes explicit ENABLE_X=false lines and the env flag WINS
      // over config.integrations — so write the flag line AND mirror config
      // so both agree.
      edits[spec.enableFlag] = enabled ? "true" : "false";
    }
    if (Object.keys(edits).length === 0) {
      return Response.json({ error: "Nothing to change" }, { status: 400 });
    }

    const { applyEnvFileEdits, readEnvFileValues } = await import("../env-file-edit");
    const { rawConfig, persistRawConfig, withConfigMutationLock } =
      await import("../config-mutation");

    return withConfigMutationLock(async () => {
      applyEnvFileEdits(edits);
      if (enabled !== undefined) {
        const config = rawConfig();
        const integrations =
          config.integrations &&
          typeof config.integrations === "object" &&
          !Array.isArray(config.integrations)
            ? (config.integrations as Record<string, unknown>)
            : {};
        config.integrations = integrations;
        const section =
          integrations[spec.id] &&
          typeof integrations[spec.id] === "object" &&
          !Array.isArray(integrations[spec.id])
            ? (integrations[spec.id] as Record<string, unknown>)
            : {};
        integrations[spec.id] = section;
        section.enabled = enabled;
        persistRawConfig(config);
      }
      audit({
        kind: "setup_integration_update",
        integration: spec.id,
        keys: Object.keys(edits),
        ...(enabled !== undefined ? { enabled } : {}),
      });
      return Response.json({
        integration: await integrationSnapshot(spec, readEnvFileValues()),
        restartRequired: true,
      });
    });
  }

  // ── PUT /api/setup/github — user PR auth + OAuth app settings ────────────
  if (path === "/api/setup/github" && req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as {
      userPrAuth?: unknown;
      oauthClientId?: unknown;
      oauthClientSecret?: unknown;
    } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (body.userPrAuth !== undefined && typeof body.userPrAuth !== "boolean") {
      return Response.json({ error: "userPrAuth must be a boolean" }, { status: 400 });
    }
    for (const field of ["oauthClientId", "oauthClientSecret"] as const) {
      if (body[field] === undefined) continue;
      const invalid = await validateSetting(body[field]);
      if (invalid) {
        return Response.json({ error: `${field}: ${invalid}` }, { status: 400 });
      }
    }
    if (
      body.userPrAuth === undefined &&
      body.oauthClientId === undefined &&
      body.oauthClientSecret === undefined
    ) {
      return Response.json({ error: "Nothing to change" }, { status: 400 });
    }

    const { rawConfig, persistRawConfig, withConfigMutationLock } =
      await import("../config-mutation");

    return withConfigMutationLock(async () => {
      const config = rawConfig();
      const integrations =
        config.integrations &&
        typeof config.integrations === "object" &&
        !Array.isArray(config.integrations)
          ? (config.integrations as Record<string, unknown>)
          : {};
      config.integrations = integrations;
      const github =
        integrations.github &&
        typeof integrations.github === "object" &&
        !Array.isArray(integrations.github)
          ? (integrations.github as Record<string, unknown>)
          : {};
      integrations.github = github;
      if (body.userPrAuth !== undefined) github.userPrAuth = body.userPrAuth;
      for (const field of ["oauthClientId", "oauthClientSecret"] as const) {
        const value = body[field];
        if (value === undefined) continue;
        if (value === "") delete github[field]; // empty string clears
        else github[field] = value;
      }
      persistRawConfig(config);
      audit({
        kind: "setup_github_update",
        fields: (["userPrAuth", "oauthClientId", "oauthClientSecret"] as const).filter(
          (f) => body[f] !== undefined,
        ),
      });
      // githubUserAuthSettings() reads getConfig() per call (mtime-guarded
      // re-read), and the web-auth gate calls webAuthRequired() →
      // githubUserAuthActive() on every request, so the sign-in gate and the
      // device flow pick this up live. No restart needed. (Only the one-time
      // createdByLogin boot migration waits for the next restart.)
      return Response.json({
        github: await githubSnapshot(),
        restartRequired: false,
      });
    });
  }

  // ── POST /api/setup/restart — apply boot-path changes ────────────────────
  if (path === "/api/setup/restart" && req.method === "POST") {
    // Restarting here means "SIGTERM myself and trust something to revive me".
    // Under `bun run opensession.ts` in a terminal — the first thing a new
    // operator does — nothing revives us, so the button was a kill switch that
    // reported itself as a restart. Refuse instead, and say who should do it.
    if (!processIsSupervised()) {
      return Response.json(
        {
          error:
            "This server isn't running under a service manager, so stopping it would just stop it. Restart it yourself where you started it (or install the service with `opensession service install`).",
          supervised: false,
        },
        { status: 409 },
      );
    }
    if (!restartState.pending) {
      restartState.pending = true;
      audit({ kind: "setup_restart", by: ctx.authUser?.login || null });
      console.log("[setup] restart requested via web setup — SIGTERM in 300ms");
      // Answer first, then trigger the existing graceful shutdown (drain +
      // journal in opensession.ts); systemd Restart=always revives us.
      setTimeout(() => {
        process.kill(process.pid, "SIGTERM");
      }, 300);
    }
    return Response.json({ restarting: true });
  }

  // ── Sibling modules: /api/setup/team*, /api/setup/{github/repos,repos},
  //    /api/setup/codestorage/{connect,status,disconnect} ───────────────────
  return (
    (await handleSetupTeamRoutes(ctx)) ??
    (await handleSetupRepoRoutes(ctx)) ??
    (await handleSetupCodestorageRoutes(ctx))
  );
}
