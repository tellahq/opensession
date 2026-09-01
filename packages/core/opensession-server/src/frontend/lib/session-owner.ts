/**
 * Who a session belongs to. This is the person lens the search palette, the
 * sidebar and the Archived page all read.
 *
 * `startedBy` is a free-text display name, and the session list holds far more
 * than teammates: spawned workers ("worker os-019fe…"), goal and automation
 * names, integration senders and the agent persona all land in that field. So
 * person options are drawn against the team directory (GET /api/people,
 * lib/people) rather than against every distinct string. An unfiltered list is
 * mostly job names and session ids.
 *
 * The directory is also what merges one person's spellings: chat integrations
 * write a full name where the web writes a first name, a GitHub grant writes a
 * login, and a /loop session writes "Kent (loop)". All four answer to the same
 * option.
 */

import {
  AGENT_PERSON_KEY,
  AUTOMATION_MACHINE_IDENTITY,
} from "./automation-audience";
import { AGENT_NAME } from "./brand";
import type { Person } from "./people";
import type { UnifiedSession } from "./types";

/** Lowercased first name, full name and GitHub login → the roster's display name. */
export function canonicalNames(roster: Person[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of roster) {
    if (!p.name) continue;
    map.set(p.name.toLowerCase(), p.name);
    if (p.fullName) map.set(p.fullName.toLowerCase(), p.name);
    if (p.github) map.set(p.github.toLowerCase(), p.name);
  }
  return map;
}

/**
 * The roster name behind a raw starter, or null when the directory doesn't
 * recognize it. A trailing qualifier is dropped before the second look-up:
 * "Kent (loop)" is Kent's session, started on his behalf by the loop he set.
 */
export function rosterNameFor(
  raw: string | null | undefined,
  canonical: Map<string, string>,
): string | null {
  const name = (raw || "").trim().toLowerCase();
  if (!name) return null;
  return (
    canonical.get(name) ||
    canonical.get(name.replace(/\s*\([^)]*\)$/, "").trim()) ||
    null
  );
}

/**
 * The key a display name files under: the roster's name when it is a
 * teammate's, the raw name lowercased otherwise, so the lens still works
 * before /api/people lands and for people the directory doesn't carry.
 */
export function ownerKey(
  name: string | null | undefined,
  canonical: Map<string, string>,
): string {
  const raw = (name || "").trim().toLowerCase();
  if (raw === AUTOMATION_MACHINE_IDENTITY) return AGENT_PERSON_KEY;
  return rosterNameFor(raw, canonical)?.toLowerCase() || raw;
}

/** The owner key a session filters under. */
export function ownerKeyOf(
  session: UnifiedSession,
  canonical: Map<string, string>,
): string {
  return ownerKey(session.startedBy, canonical);
}

export function sessionHasOwner(
  session: UnifiedSession,
  owner: string,
  canonical: Map<string, string>,
): boolean {
  return (
    !session.automation &&
    !!session.startedBy &&
    ownerKeyOf(session, canonical) === owner
  );
}

/**
 * People who started something in `sessions`, most-active first. Machine-created
 * sessions belong to the agent rather than to whichever teammate is looking.
 * An automation run belongs to whoever the automation reports to rather than to
 * the name on the run, so it counts for nobody here; `exclude` drops the
 * signed-in person where their own row is offered separately.
 */
export function sessionOwners(
  sessions: UnifiedSession[],
  canonical: Map<string, string>,
  exclude = "",
): Array<{ key: string; label: string }> {
  const entries = new Map<string, { label: string; count: number }>();
  for (const s of sessions) {
    if (s.automation || !s.startedBy) continue;
    const key = ownerKeyOf(s, canonical);
    const label =
      key === AGENT_PERSON_KEY
        ? AGENT_NAME
        : rosterNameFor(s.startedBy, canonical);
    if (!label || key === exclude) continue;
    const entry = entries.get(key) || { label, count: 0 };
    entry.count++;
    entries.set(key, entry);
  }
  return Array.from(entries.entries())
    .sort(
      (a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label),
    )
    .map(([key, { label }]) => ({ key, label }));
}
