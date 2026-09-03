/**
 * Consolidated user/email/ID mappings across GitHub, Slack, and Linear.
 *
 * The tables are DERIVED from `configuredIdentity()` (identity.team +
 * identity.slackNames in ~/.opensession/config.json). Derivation happens once
 * at module load. An empty configured team means
 * empty tables: attribution/gating/ask-routing become no-ops, never throws.
 */
import { configuredIdentity, type TeamMember } from "../config";

/** Moved to the protocol package; re-exported for existing import sites. */
export type { GitIdentity } from "@tellahq/opensession-protocol/identity";
import type { GitIdentity } from "@tellahq/opensession-protocol/identity";

type TeamGitIdentityEntry = GitIdentity & {
  aliases: string[];
  slackId?: string;
  github?: string;
};

export interface DerivedIdentityTables {
  githubToSlack: Record<string, string>;
  linearEmailToGithub: Record<string, string>;
  slackIdToName: Record<string, string>;
  teamGitIdentity: TeamGitIdentityEntry[];
}

/**
 * Build the four mapping tables from an identity roster. Exported for the
 * derivation test; runtime code uses the module-level tables below.
 * - githubToSlack: members with both ids, unless `githubToSlack: false`.
 * - linearEmailToGithub: each member's linearEmails → their GitHub login.
 * - slackIdToName: members' slackId → name, plus the extra slackNames map.
 * - teamGitIdentity: members with a git email (aliases default to the
 *   lowercased first name).
 */
export function deriveIdentityTables(
  team: TeamMember[],
  slackNames: Record<string, string> = {},
): DerivedIdentityTables {
  const githubToSlack: Record<string, string> = {};
  const linearEmailToGithub: Record<string, string> = {};
  const slackIdToName: Record<string, string> = {};
  const teamGitIdentity: TeamGitIdentityEntry[] = [];

  for (const m of team) {
    if (m.github && m.slackId && m.githubToSlack !== false) {
      githubToSlack[m.github] = m.slackId;
    }
    if (m.github) {
      for (const email of m.linearEmails ?? []) {
        linearEmailToGithub[email.toLowerCase()] = m.github;
      }
    }
    if (m.slackId) slackIdToName[m.slackId] = m.name;
    if (m.email) {
      teamGitIdentity.push({
        name: m.name,
        email: m.email,
        aliases: m.aliases?.length
          ? m.aliases.map((a) => a.toLowerCase())
          : [m.name.split(" ")[0].toLowerCase()],
        ...(m.slackId ? { slackId: m.slackId } : {}),
        ...(m.github ? { github: m.github } : {}),
      });
    }
  }
  Object.assign(slackIdToName, slackNames);

  return { githubToSlack, linearEmailToGithub, slackIdToName, teamGitIdentity };
}

let identity = configuredIdentity();
const tables = deriveIdentityTables(identity.team, identity.slackNames);

/** GitHub username → Slack user ID */
export const GITHUB_TO_SLACK: Record<string, string> = tables.githubToSlack;

/** Linear email → GitHub username (for PR reviewer assignment) */
export const LINEAR_EMAIL_TO_GITHUB: Record<string, string> =
  tables.linearEmailToGithub;

/** Slack user ID → full display name (single source of truth) */
export const SLACK_ID_TO_NAME: Record<string, string> = tables.slackIdToName;

export function slackIdToFirstName(id: string): string | null {
  const name = SLACK_ID_TO_NAME[id];
  return name ? name.split(" ")[0] : null;
}

/**
 * Resolve a teammate reference — a Slack user id, a first name / alias, a full
 * name, or a GitHub login — to their Slack id + display name, for the
 * human-in-the-loop asks (src/server/human-asks.ts). Reuses the same identity
 * table as commit attribution so a name / alias / GitHub login / raw U-id
 * all land on the same person. Returns null for unknown references.
 */
export function resolveTeammate(
  ref?: string | null,
): { slackId: string; name: string } | null {
  if (!ref) return null;
  const key = ref.trim().replace(/^@/, "");
  if (!key) return null;

  // Raw Slack id.
  if (/^U[A-Z0-9]{6,}$/.test(key)) {
    const name = SLACK_ID_TO_NAME[key];
    return name ? { slackId: key, name } : null;
  }
  // Name / alias / GitHub login → identity → slackId.
  const id = gitIdentityFor(key);
  if (id) {
    const member = TEAM_GIT_IDENTITY.find((p) => p.name === id.name);
    if (member?.slackId) {
      return {
        slackId: member.slackId,
        name: SLACK_ID_TO_NAME[member.slackId] || member.name,
      };
    }
  }
  return null;
}

export function githubUsernameToSlackId(username: string): string | null {
  return GITHUB_TO_SLACK[username] || null;
}

/**
 * GitHub login → the web user-picker key (the lowercased first name, e.g.
 * "kentdebruin" → "kent"). Lets the UI attribute a PR to a teammate: the
 * sidebar's Open PRs section shows a person's PRs whether they authored them
 * from their own account or the bot opened them from a session they started.
 */
export function githubLoginToPersonKeyFromTeam(
  login: string | null | undefined,
  team: TeamMember[],
): string | null {
  if (!login) return null;
  const lower = login.toLowerCase();
  const member = team.find((m) => m.github?.toLowerCase() === lower);
  if (!member) return null;
  return (
    member.aliases?.[0]?.toLowerCase() ||
    member.name.split(" ")[0].toLowerCase()
  );
}

export function githubLoginToPersonKey(login?: string | null): string | null {
  return githubLoginToPersonKeyFromTeam(login, identity.team);
}

/**
 * Whether a GitHub login is explicitly trusted by this Open Session instance.
 * This is deliberately roster-based, not `author_association`-based: a public
 * repository's contributors and outside collaborators are not automatically
 * allowed to command the GitHub agent. Missing login/roster data fails closed.
 */
export function isTrustedGithubLogin(login?: string | null): boolean {
  if (!login) return false;
  const normalized = login.trim().replace(/^@/, "").toLowerCase();
  if (!normalized) return false;
  return identity.team.some(
    (member) => member.github?.trim().toLowerCase() === normalized,
  );
}

/**
 * Whether a strong sender identifier resolves to anyone on the configured
 * team. This intentionally accepts only exact GitHub logins, Slack ids, and
 * email addresses. Names and aliases are attribution conveniences, not
 * authentication evidence. Public GitHub webhooks must still use the stricter
 * `isTrustedGithubLogin` helper above.
 */
export function isTrustedUser(ref?: string | null): boolean {
  if (!ref) return false;
  const key = ref.trim().replace(/^@/, "");
  if (!key) return false;
  const lower = key.toLowerCase();
  return identity.team.some(
    (member) =>
      member.github?.toLowerCase() === lower ||
      member.slackId === key ||
      member.email?.toLowerCase() === lower ||
      member.linearEmails?.some((email) => email.toLowerCase() === lower),
  );
}

/**
 * A commit's git author → the same web user-picker key PRs are attributed
 * with, so a repo that ships as commits credits the same face as one that
 * ships as pull requests. The email is the strong signal; the name covers a
 * teammate committing from a machine whose git email isn't the configured one.
 * Null for anyone off the roster, including the bot identity.
 */
export function personKeyForGitAuthor(
  name?: string | null,
  email?: string | null,
): string | null {
  const id = gitIdentityFor(email) ?? gitIdentityFor(name);
  const member = id ? identity.team.find((m) => m.name === id.name) : undefined;
  if (!member) return null;
  return (
    member.aliases?.[0]?.toLowerCase() ||
    member.name.split(" ")[0].toLowerCase()
  );
}

/** Resolve a web-picker person key to the canonical first name used by push
 * subscriptions. This intentionally covers configured members without a git
 * email; receiving notifications should not depend on commit attribution. */
export function personKeyToDisplayName(
  ref?: string | null,
  team: TeamMember[] = identity.team,
): string | null {
  if (!ref) return null;
  const key = ref.trim().toLowerCase();
  const member = team.find((m) => {
    const aliases = m.aliases?.length
      ? m.aliases.map((alias) => alias.toLowerCase())
      : [m.name.split(" ")[0].toLowerCase()];
    return aliases.includes(key) || m.name.toLowerCase() === key;
  });
  return member?.name.split(" ")[0] || null;
}

export function linearEmailToGithubUsername(
  email: string | null,
): string | null {
  if (!email) return null;
  return LINEAR_EMAIL_TO_GITHUB[email] || null;
}

/**
 * Resolve a teammate reference (a web-picker first name like "Kent", a full
 * name, an alias, a Slack id, or an email) to their GitHub login — for turning
 * an Open Session review request into a real GitHub reviewer assignment. Reuses the
 * same identity table as commit attribution. Returns null for anyone without a
 * known GitHub account.
 */
export function githubLoginFor(ref?: string | null): string | null {
  const id = gitIdentityFor(ref);
  if (!id) return null;
  return TEAM_GIT_IDENTITY.find((p) => p.name === id.name)?.github ?? null;
}

/**
 * Resolve an authenticated Slack sender to the GitHub login on that same
 * roster entry. Display names and legacy Slack aliases are not authority.
 */
export function githubLoginForTrustedSlackId(
  slackId?: string | null,
): string | null {
  if (!slackId) return null;
  const matches = identity.team.filter((member) => member.slackId === slackId);
  if (matches.length !== 1) return null;
  return matches[0]?.github ?? null;
}

/**
 * Ground-truth git identities — the exact (name, email) each teammate's
 * commits already use, so GitHub attributes commits we author on their behalf
 * to the right account (`noreply` addresses where the person commits with
 * one). Derived from the configured roster.
 *
 * `aliases` covers the web user-picker first names (UserPicker TEAM) and is matched
 * case-insensitively; `slackId`/`github` let us resolve Slack senders and Linear
 * issue creators to the same identity.
 */
const TEAM_GIT_IDENTITY: TeamGitIdentityEntry[] = tables.teamGitIdentity;

/**
 * Resolve a prompt author — a web user-picker name, a Slack user id, or an email
 * (e.g. a Linear issue creator) — to a git identity for commit attribution.
 * Returns null for unknown/anonymous/bot authors so their commits keep the
 * machine's default git identity rather than being mis-attributed.
 */
export function gitIdentityFor(user?: string | null): GitIdentity | null {
  if (!user) return null;
  // Drop a trailing parenthetical like " (loop)" the queue/loop paths append.
  const key = user
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  if (!key || key.toLowerCase() === "anonymous") return null;

  const found = ((): (typeof TEAM_GIT_IDENTITY)[number] | undefined => {
    // Slack user id (e.g. "U08S8B3P83X")
    if (/^U[A-Z0-9]{6,}$/.test(key)) {
      const bySlack = TEAM_GIT_IDENTITY.find((p) => p.slackId === key);
      if (bySlack) return bySlack;
      const name = SLACK_ID_TO_NAME[key]?.toLowerCase();
      return name
        ? TEAM_GIT_IDENTITY.find((p) => p.name.toLowerCase() === name)
        : undefined;
    }
    // Email — match the git email directly, or map a Linear account email → github.
    if (key.includes("@")) {
      const lower = key.toLowerCase();
      const byEmail = TEAM_GIT_IDENTITY.find(
        (p) => p.email.toLowerCase() === lower,
      );
      if (byEmail) return byEmail;
      const gh = LINEAR_EMAIL_TO_GITHUB[lower];
      return gh ? TEAM_GIT_IDENTITY.find((p) => p.github === gh) : undefined;
    }
    // A GitHub login (e.g. a PR author / label applier), a web-picker name, an
    // alias (first name), or the first token of the full name.
    const lower = key.toLowerCase();
    return TEAM_GIT_IDENTITY.find(
      (p) =>
        p.github?.toLowerCase() === lower ||
        p.name.toLowerCase() === lower ||
        p.aliases.includes(lower) ||
        p.name.toLowerCase().split(" ")[0] === lower,
    );
  })();

  return found ? { name: found.name, email: found.email } : null;
}

/**
 * Who a turn's commits belong to: whoever sent the prompt, and failing that
 * whoever the session belongs to.
 *
 * Not every turn has a sender. An auto-continue nudge, a restart resume, an
 * engine handoff and a queue drain all run under a synthetic name that is on
 * no roster, and the work they commit is still the session owner's — so
 * without the fallback those commits land under the machine's default identity
 * and drop out of every per-person view, in the middle of a session whose
 * other commits carry the owner's name.
 *
 * An owner who is not a person still gets named. An automation owns its
 * sessions, and "an automation did it" is an answer; the machine's default
 * identity is not, because every unattended run in the instance shares it and
 * the work becomes unattributable. So a non-roster owner is carried through as
 * the author's name, and only a turn with no owner at all keeps the default.
 */
export function commitAuthorFor(
  user?: string | null,
  sessionOwner?: string | null,
): GitIdentity | null {
  return (
    gitIdentityFor(user) ??
    gitIdentityFor(sessionOwner) ??
    labelIdentity(sessionOwner)
  );
}

/**
 * A git identity for something that isn't on the roster: an automation, a
 * goal, an agent loop. The name is what the thing is called; the email is left
 * to the machine's own git config, because these commits do belong to the
 * instance's account and only the name is in question.
 *
 * Placeholder owners are dropped rather than written into history: "Anonymous"
 * is the absence of an owner, and the persona name is what a session records
 * when nobody was named at all.
 */
export function labelIdentity(label?: string | null): GitIdentity | null {
  const name = (label || "")
    .trim()
    .replace(/\s*\(automation\)\s*$/i, "")
    .trim();
  if (
    !name ||
    ["anonymous", "assistant", "unknown"].includes(name.toLowerCase())
  )
    return null;
  return { name, email: "" };
}

/**
 * Does `user` resolve to one of the identities in `allowed`? Used to gate
 * per-user MCP servers (mcp-config.json `allowedUsers`): both sides are run
 * through the same identity table as commit attribution, so a configured name
 * matches a run whose user is an alias / GitHub login / email /
 * their Slack id. Falls back to a case-insensitive raw-string match so an
 * arbitrary label that doesn't map to a known teammate still works if it's an
 * exact match. Returns false for an anonymous/unknown user against a non-empty
 * list (fail-closed: unidentified callers don't get restricted servers).
 */
/** IANA timezone for a teammate ref (name/alias/Slack id/email/login),
 * falling back to the instance's configured timezone and then UTC. */
export function timezoneForUser(ref?: string | null): string {
  const id = gitIdentityFor(ref);
  const member = id ? identity.team.find((m) => m.name === id.name) : undefined;
  return member?.timezone || identity.defaultTimezone;
}

export function userMatchesAny(
  user: string | null | undefined,
  allowed: string[],
): boolean {
  if (!allowed?.length) return true; // no restriction
  if (!user) return false;
  const userId = gitIdentityFor(user);
  const userNorm = user.trim().toLowerCase();
  return allowed.some((a) => {
    if (!a) return false;
    if (a.trim().toLowerCase() === userNorm) return true;
    const allowedId = gitIdentityFor(a);
    return !!(allowedId && userId && allowedId.email === userId.email);
  });
}

/** Test seam (bun tests only) — mirrors codex-accounts's __setXForTest
 *  naming. The tables above are baked from this host's
 *  ~/.opensession/config.json at module load, which makes roster-dependent
 *  assertions host-dependent; this swaps in a fixture roster instead. The
 *  exported tables are mutated in place so existing importers see the
 *  fixture. Returns a restore function that re-derives from the real config. */
export function __setIdentitiesForTest(
  team: TeamMember[],
  slackNames: Record<string, string> = {},
): () => void {
  const prev = identity;
  identity = { ...prev, team, slackNames };
  applyDerivedTables(deriveIdentityTables(team, slackNames));
  return () => {
    identity = prev;
    applyDerivedTables(deriveIdentityTables(prev.team, prev.slackNames));
  };
}

function applyDerivedTables(next: DerivedIdentityTables): void {
  for (const [target, source] of [
    [GITHUB_TO_SLACK, next.githubToSlack],
    [LINEAR_EMAIL_TO_GITHUB, next.linearEmailToGithub],
    [SLACK_ID_TO_NAME, next.slackIdToName],
  ] as const) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
  }
  TEAM_GIT_IDENTITY.length = 0;
  TEAM_GIT_IDENTITY.push(...next.teamGitIdentity);
}

/**
 * Build the git author/committer env vars for an agent's child process. Setting
 * these on the process attributes every commit it makes during the run, without
 * mutating repo config (so parallel runs in different worktrees never race).
 * Empty when there's no resolved author — the run keeps the default identity.
 *
 * An identity may carry a name and no email (labelIdentity: an automation, a
 * goal). Then only the name is set and git resolves the address from its own
 * config, which is the instance's account and the right owner of the commit.
 * Never write an empty GIT_AUTHOR_EMAIL: git takes it literally and writes a
 * commit with no address rather than falling back.
 */
export function gitIdentityEnv(
  author?: GitIdentity | null,
): Record<string, string> {
  if (!author?.name) return {};
  const named = {
    GIT_AUTHOR_NAME: author.name,
    GIT_COMMITTER_NAME: author.name,
  };
  if (!author.email) return named;
  return {
    ...named,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_EMAIL: author.email,
  };
}
