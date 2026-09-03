/**
 * Team roster CRUD for the web setup page — mutates `identity.team` in
 * config.json. Part of the /api/setup family (dispatched from setup.ts).
 *
 * Raw entries are edited in place with unknown keys preserved; every
 * candidate member must pass parseTeamMember (the config loader's own rules)
 * before it is written, so the roster can never gain an entry the loader
 * would drop. All writes serialize under the shared config mutation lock.
 */

import { audit } from "../audit";
import {
  configuredIntegration,
  configuredRepos,
  parseTeamMember,
  type TeamMember,
} from "../config";
import {
  persistRawConfig,
  rawConfig,
  withConfigMutationLock,
} from "../config-mutation";
import { validateEnvValue } from "../env-file-edit";
import { githubCredentialForLogin } from "../github-auth";
import { fetchWithTimeout } from "../shared/fetch-with-timeout";
import type { RouteContext } from "./context";

const STRING_FIELDS = [
  "name",
  "email",
  "slackId",
  "github",
  "timezone",
] as const;
const STRING_ARRAY_FIELDS = ["aliases", "linearEmails"] as const;
const BOOLEAN_FIELDS = ["githubToSlack", "directory"] as const;

type MemberPatch = Record<string, unknown>;

export const LOCAL_USER_NAME = "Local User";

/** Validate one request body field; returns an error string or null. A field
 *  not present in the body is untouched. `null` means "delete the field"
 *  (PUT-merge only; `name` can never be deleted). */
function validateMemberFields(
  body: Record<string, unknown>,
  allowNullDeletes: boolean,
): string | null {
  for (const field of STRING_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null && allowNullDeletes && field !== "name") continue;
    const err = validateEnvValue(value);
    if (err) return `${field}: ${err}`;
  }
  for (const field of STRING_ARRAY_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null && allowNullDeletes) continue;
    if (!Array.isArray(value)) return `${field}: must be an array of strings`;
    for (const item of value) {
      const err = validateEnvValue(item);
      if (err) return `${field}: ${err}`;
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null && allowNullDeletes) continue;
    if (typeof value !== "boolean") return `${field}: must be a boolean`;
  }
  const known = new Set<string>([
    ...STRING_FIELDS,
    ...STRING_ARRAY_FIELDS,
    ...BOOLEAN_FIELDS,
  ]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) return `unknown field: ${key}`;
  }
  return null;
}

/** The raw `identity.team` array (unknown keys preserved), plus the raw
 *  config it lives in — mutate the array, then persist the config. Exported so
 *  the connect-time auth bootstrap (routes/connections.ts) upserts the first
 *  admin through the same array the team CRUD uses. */
export function rawTeam(config: Record<string, unknown>): MemberPatch[] {
  const identity =
    config.identity &&
    typeof config.identity === "object" &&
    !Array.isArray(config.identity)
      ? (config.identity as Record<string, unknown>)
      : {};
  config.identity = identity;
  const team = Array.isArray(identity.team) ? identity.team : [];
  identity.team = team;
  return team.filter(
    (m): m is MemberPatch => !!m && typeof m === "object" && !Array.isArray(m),
  );
}

function memberName(entry: MemberPatch): string {
  return typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
}

function memberGithub(entry: MemberPatch): string {
  return typeof entry.github === "string"
    ? entry.github.trim().toLowerCase()
    : "";
}

/** The untouched first-run identity. Once it gains any real identity field or
 * is renamed, it is an ordinary member and must never be removed implicitly. */
export function isDisposableLocalMember(entry: MemberPatch): boolean {
  return entry.name === LOCAL_USER_NAME && Object.keys(entry).length === 1;
}

/** Materialize the local identity for an installer-era incomplete config that
 * still has an empty roster. Returns whether the config needs persisting. */
export function ensureLocalOnboardingMember(
  config: Record<string, unknown>,
): boolean {
  if (config.onboardingCompleted !== false) return false;
  const team = rawTeam(config);
  if (team.some((entry) => parseTeamMember(entry))) return false;
  team.push({ name: LOCAL_USER_NAME });
  (config.identity as Record<string, unknown>).team = team;
  return true;
}

/** Prefer the explicit App installation owner, then the most common owner
 * among registered GitHub repositories. The repository step runs before the
 * people step, so a normal first-mile flow has this by the time it needs it. */
function githubOrganization(): string | null {
  const integration = configuredIntegration("github");
  const explicit = [integration.installationOwner, integration.appOrg].find(
    (owner): owner is string => typeof owner === "string" && !!owner.trim(),
  );
  if (explicit) return explicit.trim();

  const counts = new Map<string, { owner: string; count: number }>();
  for (const repo of Object.values(configuredRepos())) {
    if (repo.host === "codestorage") continue;
    const owner = repo.ghRepo.split("/")[0]?.trim();
    if (!owner) continue;
    const key = owner.toLowerCase();
    const current = counts.get(key);
    counts.set(key, { owner, count: (current?.count ?? 0) + 1 });
  }
  return (
    [...counts.values()].sort((a, b) => b.count - a.count)[0]?.owner ?? null
  );
}

interface GithubOrganizationMember {
  login?: unknown;
  type?: unknown;
}

async function fetchGithubOrganizationMembers(
  organization: string,
  token: string,
): Promise<string[]> {
  const members: string[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await fetchWithTimeout(
      `https://api.github.com/orgs/${encodeURIComponent(organization)}/members?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opensession",
        },
      },
    );
    const body = (await response.json().catch(() => null)) as
      | GithubOrganizationMember[]
      | { message?: unknown }
      | null;
    if (!response.ok) {
      const detail =
        body && !Array.isArray(body) && typeof body.message === "string"
          ? ` ${body.message}`
          : "";
      throw new Error(
        `GitHub could not list members for ${organization}.${detail} Make sure the credential can read organization members.`,
      );
    }
    if (!Array.isArray(body))
      throw new Error("GitHub returned an invalid member list.");
    for (const item of body) {
      if (item.type === "Bot") continue;
      if (typeof item.login === "string" && item.login.trim())
        members.push(item.login.trim());
    }
    if (body.length < 100) break;
  }
  return [
    ...new Map(members.map((login) => [login.toLowerCase(), login])).values(),
  ];
}

async function syncGithubOrganizationMembers(
  ctx: RouteContext,
): Promise<Response> {
  const organization = githubOrganization();
  const currentMembers = () => {
    const config = rawConfig();
    return rawTeam(config)
      .map(parseTeamMember)
      .filter((member): member is TeamMember => !!member);
  };
  if (!organization) {
    return Response.json({
      organization: null,
      synced: false,
      added: 0,
      members: currentMembers(),
    });
  }
  const importedOrganization =
    configuredIntegration("github").membersImportedOrganization;
  if (
    typeof importedOrganization === "string" &&
    importedOrganization.toLowerCase() === organization.toLowerCase()
  ) {
    return Response.json({
      organization,
      synced: true,
      alreadyImported: true,
      added: 0,
      members: currentMembers(),
    });
  }

  const userCredential = ctx.authUser?.login
    ? githubCredentialForLogin(ctx.authUser.login)
    : null;
  const { githubToken } = await import("../github-app");
  const userToken = userCredential?.env.GH_TOKEN;
  // The organization's own installation lists its members; the default
  // installation may belong to another account.
  const serviceToken = userToken
    ? null
    : await githubToken({ owner: organization });
  const credentials = [userToken, serviceToken].filter(
    (token, index, all): token is string =>
      !!token && all.indexOf(token) === index,
  );
  if (credentials.length === 0) {
    return Response.json({
      organization,
      synced: false,
      added: 0,
      members: currentMembers(),
      error: "Connect GitHub before importing organization members.",
    });
  }

  let logins: string[] | null = null;
  let importError: unknown = null;
  for (const token of credentials) {
    try {
      logins = await fetchGithubOrganizationMembers(organization, token);
      break;
    } catch (error) {
      importError = error;
    }
  }
  if (!logins) {
    return Response.json(
      {
        organization,
        synced: false,
        added: 0,
        members: currentMembers(),
        error:
          importError instanceof Error
            ? importError.message
            : String(importError),
      },
      { status: 502 },
    );
  }

  return withConfigMutationLock(async () => {
    const config = rawConfig();
    const team = rawTeam(config);
    const githubLogins = new Set(team.map(memberGithub).filter(Boolean));
    const names = new Set(team.map(memberName).filter(Boolean));
    let added = 0;
    for (const login of logins) {
      const key = login.toLowerCase();
      if (githubLogins.has(key) || names.has(key)) continue;
      team.push({ name: login, github: login });
      githubLogins.add(key);
      names.add(key);
      added++;
    }
    (config.identity as Record<string, unknown>).team = team;
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
    github.membersImportedOrganization = organization;
    persistRawConfig(config);
    audit({
      kind: "setup_team_update",
      action: "sync_github_organization",
      organization,
      added,
    });
    const members = team
      .map(parseTeamMember)
      .filter((member): member is TeamMember => !!member);
    return Response.json({ organization, synced: true, added, members });
  });
}

export async function handleSetupTeamRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/setup/team" && req.method === "GET") {
    const { configuredIdentity } = await import("../config");
    return Response.json({ members: configuredIdentity().team });
  }

  if (path === "/api/setup/team/sync-github" && req.method === "POST") {
    return syncGithubOrganizationMembers(ctx);
  }

  if (path === "/api/setup/team" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as MemberPatch | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const invalid = validateMemberFields(body, false);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    const member = parseTeamMember(body);
    if (!member) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }
    return withConfigMutationLock(async () => {
      const config = rawConfig();
      const team = rawTeam(config);
      const key = member.name.trim().toLowerCase();
      if (team.some((m) => memberName(m) === key)) {
        return Response.json(
          { error: `A team member named "${member.name}" already exists` },
          { status: 409 },
        );
      }
      const github = member.github?.trim().toLowerCase();
      if (github && team.some((m) => memberGithub(m) === github)) {
        return Response.json(
          { error: `GitHub account @${member.github} is already a member` },
          { status: 409 },
        );
      }
      team.push({ ...body, name: member.name });
      (config.identity as Record<string, unknown>).team = team;
      persistRawConfig(config);
      audit({
        kind: "setup_team_update",
        action: "add",
        member: member.name,
        fields: Object.keys(body),
      });
      return Response.json({ member }, { status: 201 });
    });
  }

  const memberMatch = path.match(/^\/api\/setup\/team\/([^/]+)(\/remove)?$/);
  if (memberMatch) {
    const targetName = decodeURIComponent(memberMatch[1]).trim().toLowerCase();
    const isRemove = !!memberMatch[2];

    if (isRemove && req.method === "POST") {
      return withConfigMutationLock(async () => {
        const config = rawConfig();
        const team = rawTeam(config);
        const idx = team.findIndex((m) => memberName(m) === targetName);
        if (idx === -1) {
          return Response.json(
            { error: "Team member not found" },
            { status: 404 },
          );
        }
        const removed = team[idx];
        team.splice(idx, 1);
        (config.identity as Record<string, unknown>).team = team;
        persistRawConfig(config);
        audit({
          kind: "setup_team_update",
          action: "remove",
          member: typeof removed.name === "string" ? removed.name : targetName,
        });
        return Response.json({ ok: true });
      });
    }

    if (!isRemove && req.method === "PUT") {
      const body = (await req.json().catch(() => null)) as MemberPatch | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const invalid = validateMemberFields(body, true);
      if (invalid) return Response.json({ error: invalid }, { status: 400 });
      return withConfigMutationLock(async () => {
        const config = rawConfig();
        const team = rawTeam(config);
        const idx = team.findIndex((m) => memberName(m) === targetName);
        if (idx === -1) {
          return Response.json(
            { error: "Team member not found" },
            { status: 404 },
          );
        }
        const merged: MemberPatch = { ...team[idx] };
        for (const [key, value] of Object.entries(body)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        const parsed = parseTeamMember(merged);
        if (!parsed) {
          return Response.json(
            { error: "The merged member is invalid (name is required)" },
            { status: 400 },
          );
        }
        const newKey = parsed.name.trim().toLowerCase();
        if (
          newKey !== targetName &&
          team.some((m, i) => i !== idx && memberName(m) === newKey)
        ) {
          return Response.json(
            { error: `A team member named "${parsed.name}" already exists` },
            { status: 409 },
          );
        }
        const github = parsed.github?.trim().toLowerCase();
        if (
          github &&
          team.some((m, i) => i !== idx && memberGithub(m) === github)
        ) {
          return Response.json(
            { error: `GitHub account @${parsed.github} is already a member` },
            { status: 409 },
          );
        }
        team[idx] = merged;
        (config.identity as Record<string, unknown>).team = team;
        persistRawConfig(config);
        audit({
          kind: "setup_team_update",
          action: "update",
          member: parsed.name,
          ...(newKey !== targetName ? { renamedFrom: targetName } : {}),
          fields: Object.keys(body),
        });
        return Response.json({ member: parsed });
      });
    }
  }

  return undefined;
}

/** Exported for reuse by sibling setup modules. */
export type { TeamMember };
