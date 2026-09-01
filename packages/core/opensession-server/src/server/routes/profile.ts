/**
 * Your own profile: what Settings > Personal > Account reads and writes.
 *
 * AUTHZ, and the reason this is a route family of its own rather than a
 * relaxation of /api/setup/team: every /api/setup/* path is workspace-admin
 * only (routes/setup.ts), which is right for editing the roster, and wrong for
 * editing your own row in it. These routes take NO member identifier. The row
 * is resolved from the caller's verified identity, so "you may only patch
 * yourself" is not a check that can be forgotten or bypassed by a body field,
 * it is the only row the route can address. Admins editing other people keep
 * using Settings > Members.
 *
 * When web sign-in is off there is no verified identity, so the caller's
 * claimed `?user=` is trusted, exactly as every other per-user surface in that
 * mode does (prefs, pins, personal prompts). That mode is a single-tenant
 * instance behind a tailnet, and tightening only this one surface would make
 * the profile page the sole thing a signed-out instance cannot use.
 *
 * The editable set is an allowlist, and it is smaller than the roster row:
 *
 * - `github` is excluded because it is the sign-in key (web-auth.ts resolves a
 *   browser session by login) AND the admin-role match key (workspace-auth.ts).
 *   Editing it could lock someone out of their own instance, or hand the
 *   `admin: true` flag on their row to a different account.
 * - `slackId`, `admin`, `directory`, `githubToSlack` and `linearEmails` are
 *   workspace wiring rather than profile, and misrouting notifications is a
 *   silent failure. They stay on the Members page.
 */

import { audit } from "../audit";
import {
  configuredIdentity,
  parseTeamMember,
  type TeamMember,
} from "../config";
import {
  persistRawConfig,
  rawConfig,
  withConfigMutationLock,
} from "../config-mutation";
import { validateEnvValue } from "../env-file-edit";
import { renameUserState } from "../shared/user-store";
import {
  clearProfileImage,
  MAX_PROFILE_IMAGE_BYTES,
  PROFILE_IMAGE_TYPES,
  profileImageFor,
  setProfileImage,
} from "../user-profiles";
import { webAuthRequired } from "../web-auth";
import type { RouteContext } from "./context";

/** Roster fields a person may change about themselves. */
const EDITABLE_STRINGS = ["name", "email", "timezone"] as const;
const EDITABLE_ARRAYS = ["aliases"] as const;

/** The person this request is. In sign-in mode the verified identity decides
 *  and a claimed name is ignored; otherwise the client's own name is all
 *  there is. */
function callerName(ctx: RouteContext): string {
  if (webAuthRequired()) return ctx.authUser?.name?.trim() || "";
  const claimed = new URL(ctx.req.url).searchParams.get("user");
  return claimed?.trim() || "";
}

/** The caller's roster row. A verified GitHub login is authoritative in
 *  sign-in mode. The display name can be stale when a member was renamed
 *  between requests. Without sign-in, resolve the spellings a client may
 *  claim the same way the rest of the identity layer does. */
function memberFor(name: string, verifiedLogin?: string): TeamMember | null {
  const key = name.trim().toLowerCase();
  const team = configuredIdentity().team;
  const loginKey = verifiedLogin?.trim().toLowerCase();
  if (loginKey) {
    const verified = team.find(
      (m) => m.github?.trim().toLowerCase() === loginKey,
    );
    if (verified) return verified;
  }
  if (!key) return null;
  return (
    team.find((m) => m.name.trim().toLowerCase() === key) ||
    team.find((m) => m.github?.trim().toLowerCase() === key) ||
    team.find((m) => m.email?.trim().toLowerCase() === key) ||
    team.find((m) => m.name.trim().split(/\s+/)[0]?.toLowerCase() === key) ||
    // Aliases exist so a person's other spellings resolve to them, which is
    // the same question this is asking. It only matters without sign-in,
    // where the name is whatever the client calls itself.
    team.find((m) => m.aliases?.some((a) => a.trim().toLowerCase() === key)) ||
    null
  );
}

/** What the profile page renders. `editable` is false for a signed-in user who
 *  is not on the roster: they can still be shown who they are. */
function profilePayload(name: string, member: TeamMember | null) {
  return {
    user: name,
    editable: !!member,
    name: member?.name ?? name,
    shortName: (member?.name ?? name).trim().split(/\s+/)[0] ?? "",
    email: member?.email ?? "",
    github: member?.github ?? "",
    slackId: member?.slackId ?? "",
    timezone: member?.timezone ?? "",
    aliases: member?.aliases ?? [],
    image: profileImageFor(member?.name ?? name),
    imageMaxBytes: MAX_PROFILE_IMAGE_BYTES,
  };
}

export async function handleProfileRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (path !== "/api/profile" && path !== "/api/profile/image")
    return undefined;

  const name = callerName(ctx);
  if (!name)
    return Response.json(
      { error: "Sign in to edit your profile" },
      { status: 401 },
    );

  const verifiedLogin = webAuthRequired() ? ctx.authUser?.login : undefined;
  const member = memberFor(name, verifiedLogin);
  const profileName = verifiedLogin && member ? member.name : name;

  if (path === "/api/profile" && req.method === "GET") {
    return Response.json(profilePayload(profileName, member));
  }

  if (path === "/api/profile" && req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body))
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });

    const invalid = validateProfileFields(body);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });

    const current = member;
    if (!current)
      return Response.json(
        {
          error:
            "You are not on this instance's team roster yet, so there is no profile to edit. Ask an admin to add you on Settings > Members.",
        },
        { status: 404 },
      );

    return withConfigMutationLock(async () => {
      const config = rawConfig();
      const identity =
        config.identity &&
        typeof config.identity === "object" &&
        !Array.isArray(config.identity)
          ? (config.identity as Record<string, unknown>)
          : {};
      config.identity = identity;
      const team = (Array.isArray(identity.team) ? identity.team : []).filter(
        (m): m is Record<string, unknown> =>
          !!m && typeof m === "object" && !Array.isArray(m),
      );
      // Re-find under the lock: the roster can have moved since memberFor.
      const targetKey = current.name.trim().toLowerCase();
      const targetLogin = verifiedLogin?.trim().toLowerCase();
      const idx = team.findIndex((m) =>
        targetLogin
          ? typeof m.github === "string" &&
            m.github.trim().toLowerCase() === targetLogin
          : typeof m.name === "string" &&
            m.name.trim().toLowerCase() === targetKey,
      );
      if (idx === -1)
        return Response.json(
          { error: "Team member not found" },
          { status: 404 },
        );

      const merged: Record<string, unknown> = { ...team[idx] };
      const lockedCurrent = parseTeamMember(merged);
      if (!lockedCurrent)
        return Response.json(
          { error: "Team member not found" },
          { status: 404 },
        );
      for (const [key, value] of Object.entries(body)) {
        if (value === null || value === "") delete merged[key];
        else merged[key] = value;
      }

      const previousShort = lockedCurrent.name.trim().split(/\s+/)[0] ?? "";
      const nextName = String(merged.name ?? "").trim();
      const nextShort = nextName.split(/\s+/)[0] ?? "";
      const shortNameChanged =
        !!previousShort &&
        !!nextShort &&
        previousShort.toLowerCase() !== nextShort.toLowerCase();

      // The short name is the identity key: mentions, push subscriptions,
      // `startedBy` on every session already written, and `allowedUsers`
      // grants all match on it. Renaming past it keeps working only because
      // the old spelling is kept as an alias, so identity resolution still
      // lands on this person, and their historical sessions still read as
      // theirs.
      if (shortNameChanged) {
        const aliases = new Set(
          (Array.isArray(merged.aliases) ? merged.aliases : [])
            .filter((a): a is string => typeof a === "string")
            .map((a) => a.trim())
            .filter(Boolean),
        );
        aliases.add(previousShort);
        merged.aliases = [...aliases];
      }

      const parsed = parseTeamMember(merged);
      if (!parsed)
        return Response.json({ error: "A name is required" }, { status: 400 });

      const newKey = parsed.name.trim().toLowerCase();
      if (
        newKey !== targetKey &&
        team.some(
          (m, i) =>
            i !== idx &&
            typeof m.name === "string" &&
            m.name.trim().toLowerCase() === newKey,
        )
      )
        return Response.json(
          { error: `Someone on the roster is already named "${parsed.name}"` },
          { status: 409 },
        );

      team[idx] = merged;
      identity.team = team;
      persistRawConfig(config);

      // Per-user state (pins, read marks, lanes, snoozes, hides, settlements,
      // tab colors, drafts, UI prefs) is filed under the short name, so carry it across
      // or the rename hands the person a factory-fresh sidebar.
      const carried = shortNameChanged
        ? renameUserState(previousShort, nextShort)
        : [];

      audit({
        kind: "profile_update",
        user: parsed.name,
        fields: Object.keys(body),
        ...(shortNameChanged
          ? { renamedFrom: previousShort, carriedState: carried }
          : {}),
      });
      return Response.json({
        ...profilePayload(parsed.name, parsed),
        ...(shortNameChanged
          ? { renamedFrom: previousShort, carriedState: carried }
          : {}),
      });
    });
  }

  // The picture. Raw bytes with the type in Content-Type, the same shape as
  // /api/upload, because a multipart parse buys nothing for one file.
  if (path === "/api/profile/image" && req.method === "POST") {
    const contentType = (req.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!PROFILE_IMAGE_TYPES[contentType])
      return Response.json(
        { error: "Pictures must be PNG, JPEG, GIF or WebP" },
        { status: 415 },
      );
    const declared = Number(req.headers.get("content-length") || 0);
    if (declared > MAX_PROFILE_IMAGE_BYTES)
      return Response.json(
        { error: "That picture is too large. The limit is 5MB." },
        { status: 413 },
      );
    try {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const currentName =
        memberFor(profileName, verifiedLogin)?.name ?? profileName;
      const image = await setProfileImage(
        verifiedLogin || profileName,
        bytes,
        contentType,
      );
      audit({ kind: "profile_update", user: currentName, fields: ["image"] });
      return Response.json({ ok: true, image });
    } catch (e) {
      return Response.json(
        { error: String((e as Error)?.message || e) },
        { status: 400 },
      );
    }
  }

  if (path === "/api/profile/image" && req.method === "DELETE") {
    const currentName =
      memberFor(profileName, verifiedLogin)?.name ?? profileName;
    clearProfileImage(verifiedLogin || profileName);
    audit({ kind: "profile_update", user: currentName, fields: ["image"] });
    return Response.json({ ok: true, image: "" });
  }

  return undefined;
}

/** Reject anything outside the allowlist, and reuse the config loader's own
 *  value rules so this route cannot write a row the loader would drop. */
function validateProfileFields(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (
      !(EDITABLE_STRINGS as readonly string[]).includes(key) &&
      !(EDITABLE_ARRAYS as readonly string[]).includes(key)
    )
      return `${key} is not something you can change about yourself here`;
  }
  for (const field of EDITABLE_STRINGS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null || value === "") {
      if (field === "name") return "name: a name is required";
      continue;
    }
    const err = validateEnvValue(value);
    if (err) return `${field}: ${err}`;
  }
  for (const field of EDITABLE_ARRAYS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null) continue;
    if (!Array.isArray(value)) return `${field}: must be a list`;
    for (const item of value) {
      const err = validateEnvValue(item);
      if (err) return `${field}: ${err}`;
    }
  }
  return null;
}
