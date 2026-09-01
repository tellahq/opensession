/**
 * Team directory for the frontend — the single roster the UI should use for
 * people pickers, avatars, @-mention completion and the sidebar People band.
 * Derived from the same identity config as commit attribution
 * (configuredIdentity() → ~/.backstage/config.json identity.team), so adding a
 * teammate to the config updates every people surface at once instead of the
 * historical trio of hardcoded arrays (UserPicker TEAM, UserAvatar login map,
 * a mention roster of its own).
 */

import { configuredIdentity, type ReviewTeam } from "./config";
import { profileImagesByMemberName } from "./user-profiles";

export interface DirectoryPerson {
  /** Picker/display first name — the value presence viewers,
   *  push-subscription keys and `startedBy` use. */
  name: string;
  /** Full display name from the identity roster. */
  fullName: string;
  /** GitHub login (avatar source), when known. */
  github?: string;
  /** IANA timezone, when configured. */
  timezone?: string;
  /** Uploaded profile picture as a `/media` URL, when they set one. Takes
   *  precedence over the GitHub avatar in every client (user-profiles.ts). */
  image?: string;
}

/** The mentionable/pickable team, in config order. Members flagged
 *  `directory: false` (attribution-only identities) are excluded. */
export function teamDirectory(): DirectoryPerson[] {
  // One pass over the picture store for the whole roster rather than a file
  // read per member per caller: this runs on every GET /api/people.
  const images = profileImagesByMemberName();
  return configuredIdentity()
    .team.filter((m) => m.directory !== false)
    .map((m) => ({
      name: m.name.split(" ")[0],
      fullName: m.name,
      ...(m.github ? { github: m.github } : {}),
      ...(m.timezone ? { timezone: m.timezone } : {}),
      ...(images[m.name] ? { image: images[m.name] } : {}),
    }));
}

/** Picker first names — the mention-matching + push-key roster. */
export function teamFirstNames(): string[] {
  return teamDirectory().map((p) => p.name);
}

/** Review groups offered alongside individual people in reviewer pickers. */
export function reviewTeamDirectory(): ReviewTeam[] {
  const identity = configuredIdentity();
  return identity.reviewTeams.flatMap((team) => {
    const members = [
      ...new Set(
        team.members.flatMap((ref) => {
          const key = ref.trim().toLowerCase();
          const member = identity.team.find((candidate) => {
            const aliases = candidate.aliases?.length
              ? candidate.aliases
              : [candidate.name.split(" ")[0] || ""];
            return (
              candidate.name.toLowerCase() === key ||
              aliases.some((alias) => alias.toLowerCase() === key)
            );
          });
          return member ? [member.name.split(" ")[0]!] : [];
        }),
      ),
    ];
    return members.length ? [{ ...team, members }] : [];
  });
}

/** Resolve either a group's display name or its GitHub reviewer spec. */
export function reviewTeamFor(ref?: string | null): ReviewTeam | null {
  if (!ref) return null;
  const key = ref.trim().toLowerCase();
  return (
    reviewTeamDirectory().find(
      (team) =>
        team.name.toLowerCase() === key || team.github.toLowerCase() === key,
    ) || null
  );
}

/**
 * Distinct teammates `@`-mentioned in `text` — never the sender themself.
 * Matched against the picker first names, which are also the keys push
 * subscriptions are stored under (push.ts matches exact names).
 * `@session:<id>` tags don't collide: "session" is not a teammate name.
 */
export function mentionedUsers(text: string, sender: string): string[] {
  const team = teamFirstNames();
  const found = new Set<string>();
  for (const m of text.matchAll(/@([A-Za-z][\w.-]*)/g)) {
    const name = team.find((n) => n.toLowerCase() === m[1].toLowerCase());
    if (name && name.toLowerCase() !== sender.trim().toLowerCase())
      found.add(name);
  }
  return [...found];
}
