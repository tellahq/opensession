/** Admit a verified GitHub device-flow identity. Never call with client claims. */
import { randomUUID } from "node:crypto";
import {
  parseTeamMember,
  publishConfigSnapshot,
  configPath,
  type TeamMember,
} from "./config";
import {
  persistRawConfigAsync,
  rawConfigAsync,
  withConfigMutationLock,
} from "./config-mutation";
import { rawTeam } from "./routes/setup-team";

/** Do not let a GitHub profile name/alias claim someone else's identity. Names
 * are also used as first-token identities by older clients and MCP scoping. */
function enrollmentName(login: string, team: TeamMember[]): string {
  const occupied = new Set([
    "anonymous",
    "automation",
    "assistant",
    "system",
    "unknown",
  ]);
  for (const member of team) {
    for (const ref of [
      member.name,
      member.name.split(/\s/)[0],
      member.github,
      member.email,
      member.slackId,
      ...(member.aliases ?? []),
      ...(member.linearEmails ?? []),
    ]) {
      if (ref) occupied.add(ref.trim().toLowerCase());
    }
  }
  let name = login;
  for (let n = 1; occupied.has(name.toLowerCase()); n++) {
    name = `github:${login}${n === 1 ? "" : `:${n}`}`;
  }
  return name;
}

/** The lock covers read/check/write, so repeated and racing sign-ins append
 * exactly one row. Existing identities are matched ONLY by GitHub login. */
export async function enrollGithubSignIn(login: string): Promise<TeamMember> {
  const key = login.trim().toLowerCase();
  if (!/^[a-z\d][a-z\d_-]{0,255}$/.test(key)) {
    throw new Error("Invalid verified GitHub login");
  }
  return withConfigMutationLock(async () => {
    const config = await rawConfigAsync();
    const integrations = config.integrations as
      | Record<string, unknown>
      | undefined;
    const github = integrations?.github as Record<string, unknown> | undefined;
    if (github?.userPrAuth !== true)
      throw new Error("GitHub sign-in is no longer enabled");
    const team = rawTeam(config);
    const matches = team.filter(
      (row) =>
        typeof row.github === "string" &&
        row.github.trim().toLowerCase() === key,
    );
    if (matches.length) {
      const existing =
        matches.length === 1 ? parseTeamMember(matches[0]) : undefined;
      if (!existing)
        throw new Error("Ambiguous or invalid GitHub roster entry");
      // Refresh the in-memory snapshot even when an operator edited the file.
      publishConfigSnapshot(configPath(), JSON.stringify(config));
      return existing;
    }
    const members = team
      .map(parseTeamMember)
      .filter((member): member is TeamMember => !!member);
    // Legacy rosters made everyone an admin implicitly. Adding admin:false
    // switches the roster to explicit roles; retain every existing privilege.
    if (!members.some((member) => member.admin !== undefined)) {
      for (const row of team) if (parseTeamMember(row)) row.admin = true;
    }
    const member: TeamMember = {
      name: enrollmentName(key, members),
      github: key,
      admin: false,
      authGeneration: randomUUID(),
    };
    team.push({ ...member });
    // rawTeam creates the identity section and preserves unknown config keys.
    (config.identity as Record<string, unknown>).team = team;
    await persistRawConfigAsync(config);
    return member;
  });
}
