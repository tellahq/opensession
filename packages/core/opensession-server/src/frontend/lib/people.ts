/**
 * Frontend team directory — fetched once from GET /api/people (derived
 * server-side from the identity config) and cached module-wide. The portable
 * default is empty; fetched logins are merged into UserAvatar's login map and
 * subscribers re-render via `usePeople()`.
 */

import { useEffect, useState } from "react";
import { z } from "zod";
import { BASE_PATH } from "./base";
import {
  registerGithubLogins,
  registerProfileImages,
} from "../components/UserAvatar";
import { setKnownPeople } from "./markdown";
import type { FileMention } from "./api";

export interface Person {
  /** Picker/display first name. */
  name: string;
  fullName: string;
  github?: string;
  timezone?: string;
  /** Uploaded profile picture (a `/media` URL), when they set one. */
  image?: string;
}

export interface ReviewTeam {
  name: string;
  github: string;
  members: string[];
}

const personSchema = z.object({
  name: z.string(),
  fullName: z.string(),
  github: z.string().optional(),
  timezone: z.string().optional(),
  image: z.string().optional(),
});

const reviewTeamSchema = z.object({
  name: z.string(),
  github: z.string(),
  members: z.array(z.string()),
});

const peopleResponseSchema = z.object({
  people: z.array(personSchema).optional(),
  reviewTeams: z.array(reviewTeamSchema).optional(),
});

const CHANGE_EVENT = "opensession-people-changed";
let people: Person[] = [];
let reviewTeams: ReviewTeam[] = [];
let fetched = false;

/** Current roster, synchronously (fallback until the fetch lands). */
export function getPeople(): Person[] {
  void ensurePeople();
  return people;
}

export function getReviewTeams(): ReviewTeam[] {
  void ensurePeople();
  return reviewTeams;
}

/**
 * Re-fetch the roster and tell every subscriber. The roster is otherwise
 * fetched once per page load, which is right for something an admin edits
 * rarely, and wrong the moment you edit your OWN row: your new name and
 * picture have to appear without a reload (Settings > Personal > Account).
 */
export function refreshPeople(): Promise<void> {
  fetched = false;
  return ensurePeople();
}

let inflight: Promise<void> | null = null;
export function ensurePeople(): Promise<void> {
  if (fetched) return Promise.resolve();
  if (inflight) return inflight;
  inflight = fetch(`${BASE_PATH}/api/people`)
    .then(async (response) => {
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      return peopleResponseSchema.parse(payload);
    })
    .then((body) => {
      const list = body?.people ?? [];
      people = list;
      reviewTeams = body?.reviewTeams ?? [];
      fetched = true;
      // The markdown renderer mints the @-mention chips, so it needs the
      // same roster: a name nobody on it stays prose.
      setKnownPeople(list);
      registerGithubLogins(
        Object.fromEntries(
          list.flatMap((person): [string, string][] =>
            person.github ? [[person.name.toLowerCase(), person.github]] : [],
          ),
        ),
      );
      registerProfileImages(
        Object.fromEntries(
          list.flatMap((person): [string, string][] =>
            person.image ? [[person.name.toLowerCase(), person.image]] : [],
          ),
        ),
      );
      window.dispatchEvent(new Event(CHANGE_EVENT));
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * The display name behind a GitHub login ("kentdebruin" → "Kent"), or null
 * when that login isn't a teammate. The inverse of UserAvatar's login map,
 * which only resolves name → login.
 */
export function personNameForGithubLogin(login?: string | null): string | null {
  const key = login?.trim().toLowerCase();
  if (!key) return null;
  return getPeople().find((p) => p.github?.toLowerCase() === key)?.name || null;
}

/**
 * The display name behind a person key ("michiel" → "Michiel"). Person keys are
 * what the server puts in `prReviewRequested` and `prReviewedBy`. An off-roster
 * reviewer keeps their key, capitalized, so they still read as a name.
 */
export function personNameForKey(key: string): string {
  const lower = key.trim().toLowerCase();
  if (!lower) return "";
  const match = getPeople().find(
    (p) => p.name.trim().split(/\s+/)[0]?.toLowerCase() === lower,
  );
  return match?.name || lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * People rows for the composer's @ palette. A bare "@" offers the complete
 * directory; typing filters by first or full name. The current person sorts
 * first, then the directory keeps its configured order. Inserting yields
 * `@Name`, which the server's mention scan turns into a push when sent.
 */
export function peopleMentionMatches(
  query: string,
  roster: Person[] = getPeople(),
  currentUser = "",
): FileMention[] {
  const q = query.trim().toLowerCase();
  const current = currentUser.trim().toLowerCase();
  return roster
    .filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.fullName.toLowerCase().includes(q),
    )
    .sort((a, b) => {
      const aIsCurrent = a.name.toLowerCase() === current;
      const bIsCurrent = b.name.toLowerCase() === current;
      return Number(bIsCurrent) - Number(aIsCurrent);
    })
    .map((p) => ({
      display: p.name,
      insert: p.name,
      kind: "person" as const,
      sub: p.fullName,
    }));
}

/** Reactive roster — triggers the fetch on first use. */
export function usePeople(): Person[] {
  const [list, setList] = useState(people);
  useEffect(() => {
    void ensurePeople();
    const handler = () => setList(people);
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);
  return list;
}

export function useReviewTeams(): ReviewTeam[] {
  const [list, setList] = useState(reviewTeams);
  useEffect(() => {
    void ensurePeople();
    const handler = () => setList(reviewTeams);
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);
  return list;
}
