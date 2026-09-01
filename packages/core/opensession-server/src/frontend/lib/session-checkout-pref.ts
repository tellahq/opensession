// Per-user, per-repository defaults for where NEW code sessions start. Missing
// repositories follow their workspace-wide setting. Existing sessions and
// sessions opened from a pull request keep their current checkout semantics.
//
// The map is one user preference so repositories with punctuation in their ids
// do not have to be encoded into ui-prefs keys. `session-checkouts` is admitted
// as a long value server-side for installations with many repositories.

import { makeUserPref } from "./user-pref";

export type SessionCheckoutPref = "default" | "checkout" | "worktree";
export type SessionCheckoutPrefs = Partial<
  Record<string, Exclude<SessionCheckoutPref, "default">>
>;

function parse(value: string): SessionCheckoutPrefs {
  if (!value) return {};
  try {
    const input = JSON.parse(value) as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    return Object.fromEntries(
      Object.entries(input).filter(
        (entry): entry is [string, "checkout" | "worktree"] =>
          !!entry[0] && (entry[1] === "checkout" || entry[1] === "worktree"),
      ),
    );
  } catch {
    return {};
  }
}

const pref = makeUserPref<string>({
  localKey: "opensession-session-checkouts",
  prefKey: "session-checkouts",
  changeEvent: "opensession-session-checkouts-changed",
  defaultValue: "",
  decode: (value) => (typeof value === "string" ? value : null),
  encode: (value) => value,
});

export function getSessionCheckoutPrefs(): SessionCheckoutPrefs {
  return parse(pref.get());
}

export function getSessionCheckoutPref(repo: string): SessionCheckoutPref {
  return getSessionCheckoutPrefs()[repo] ?? "default";
}

export function setSessionCheckoutPref(
  repo: string,
  value: SessionCheckoutPref,
): void {
  const next = getSessionCheckoutPrefs();
  if (value === "default") delete next[repo];
  else next[repo] = value;
  const entries = Object.entries(next).sort(([a], [b]) => a.localeCompare(b));
  pref.set(entries.length ? JSON.stringify(Object.fromEntries(entries)) : "");
}

export const onSessionCheckoutPrefChanged = pref.onChanged;
