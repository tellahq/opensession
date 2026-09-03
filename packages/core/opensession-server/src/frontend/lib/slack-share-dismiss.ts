// Dismissed "Send to Slack" cards. The card appears in the transcript under a
// merged-PR notice and offers to announce the change; closing it with the X
// means "not this one", so the dismissal has to outlive a reload. Stored per
// user in the ui-prefs map (a JSON list of `<sessionId>:<prNumber>` keys) so
// the decision follows you to your phone rather than living in one browser.
//
// Dismissing is not a dead end: the composer menu's "Send to Slack…" still
// opens a composer for the same session, so nothing is lost by closing the
// card.
//
// The store is built on first use rather than at import: makeUserPref touches
// localStorage and window immediately, and the pure helpers below are unit
// tested outside a browser.
import { z } from "zod";
import * as userPref from "./user-pref";

const LOCAL_KEY = "opensession-slack-share-dismissed";
const PREF_KEY = "slack-share-dismissed";
const CHANGE_EVENT = "opensession-slack-share-dismiss-changed";
// Newest-first, bounded: this is a list of decisions about individual merged
// PRs, and an unbounded one would grow with every session you ever closed a
// card in.
const CAP = 200;
const DISMISSED_LIST_SCHEMA = z.array(z.unknown()).transform((entries) =>
  entries.flatMap((entry) => {
    const parsed = z.string().safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }),
);

/** Identity of one card: the session it renders in, and the PR it announces. */
export function slackShareDismissKey(
  sessionId: string,
  prNumber: number,
): string {
  return `${sessionId}:${prNumber}`;
}

export function parseDismissed(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = DISMISSED_LIST_SCHEMA.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Add a key, newest first, deduped and capped. Returns the same list when the
 *  key is already dismissed, so callers can skip a pointless write. */
export function withDismissed(list: string[], key: string): string[] {
  if (!key || list.includes(key)) return list;
  return [key, ...list].slice(0, CAP);
}

let store: userPref.UserPref<string> | null = null;

function prefStore(): userPref.UserPref<string> {
  if (!store) {
    store = userPref.makeUserPref<string>({
      localKey: LOCAL_KEY,
      prefKey: PREF_KEY,
      changeEvent: CHANGE_EVENT,
      defaultValue: "",
      decode: (raw) => raw ?? null,
      encode: (value) => value,
    });
  }
  return store;
}

export function isSlackShareDismissed(key: string): boolean {
  if (!key) return false;
  return parseDismissed(prefStore().get()).includes(key);
}

export function dismissSlackShare(key: string): void {
  if (!key) return;
  const current = parseDismissed(prefStore().get());
  const next = withDismissed(current, key);
  if (next === current) return;
  prefStore().set(JSON.stringify(next));
}

export function onSlackShareDismissChanged(handler: () => void): () => void {
  return prefStore().onChanged(handler);
}
