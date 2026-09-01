// Where this person starts NEW code sessions. The `*` entry is the choice for
// all repositories; named entries override it. Missing entries keep the
// repository's workspace-wide setting. Existing sessions and sessions opened
// from a pull request keep their current checkout semantics.
//
// The map is one user preference so repository ids with punctuation do not
// have to be encoded into ui-prefs keys. `session-checkouts` is admitted as a
// long value server-side for installations with many repositories.

import { makeUserPref } from "./user-pref";

export type SessionCheckoutPref = "default" | "checkout" | "worktree";
export type SessionCheckoutOverride = Exclude<SessionCheckoutPref, "default">;
export type SessionCheckoutPrefs = Partial<
  Record<string, SessionCheckoutOverride>
>;

export const SESSION_CHECKOUT_DEFAULT_KEY = "*";

function isOverride(value: unknown): value is SessionCheckoutOverride {
  return value === "checkout" || value === "worktree";
}

function parse(value: string): SessionCheckoutPrefs {
  if (!value) return {};
  try {
    const input: unknown = JSON.parse(value);
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    return Object.fromEntries(
      Object.entries(input).filter(
        (entry): entry is [string, SessionCheckoutOverride] =>
          !!entry[0] && isOverride(entry[1]),
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

function saveSessionCheckoutPrefs(next: SessionCheckoutPrefs): void {
  const entries = Object.entries(next).sort(([a], [b]) => a.localeCompare(b));
  pref.set(entries.length ? JSON.stringify(Object.fromEntries(entries)) : "");
}

export function getSessionCheckoutPrefs(): SessionCheckoutPrefs {
  return parse(pref.get());
}

export function sessionCheckoutDefault(
  prefs: SessionCheckoutPrefs,
): SessionCheckoutPref {
  return prefs[SESSION_CHECKOUT_DEFAULT_KEY] ?? "default";
}

export function resolveSessionCheckoutPref(
  prefs: SessionCheckoutPrefs,
  repo: string,
): SessionCheckoutPref {
  return prefs[repo] ?? sessionCheckoutDefault(prefs);
}

export function getSessionCheckoutPref(repo: string): SessionCheckoutPref {
  return resolveSessionCheckoutPref(getSessionCheckoutPrefs(), repo);
}

export function setSessionCheckoutDefault(value: SessionCheckoutPref): void {
  const next = getSessionCheckoutPrefs();
  if (value === "default") delete next[SESSION_CHECKOUT_DEFAULT_KEY];
  else next[SESSION_CHECKOUT_DEFAULT_KEY] = value;

  for (const [repo, override] of Object.entries(next)) {
    if (repo !== SESSION_CHECKOUT_DEFAULT_KEY && override === value) {
      delete next[repo];
    }
  }
  saveSessionCheckoutPrefs(next);
}

export function setSessionCheckoutPref(
  repo: string,
  value: SessionCheckoutPref,
): void {
  if (!repo || repo === SESSION_CHECKOUT_DEFAULT_KEY) return;
  const next = getSessionCheckoutPrefs();
  if (value === "default" || value === sessionCheckoutDefault(next)) {
    delete next[repo];
  } else {
    next[repo] = value;
  }
  saveSessionCheckoutPrefs(next);
}

export const onSessionCheckoutPrefChanged = pref.onChanged;
