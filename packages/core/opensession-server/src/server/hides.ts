/**
 * Per-user sidebar hides. Like snoozes.ts, each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file under `~/.opensession-hides/` of shape
 * `{ hides: { [rowKey]: isoHiddenAt } }`, where `rowKey` is a sidebar row key
 * (`workspace:<id>` or a solo session id). Filename, directory resolution and
 * legacy-name fallback come from shared/user-store.ts.
 *
 * Hiding is the personal counterpart to archiving: archive.ts is a GLOBAL
 * registry, so archiving a session removes it for the whole team — wrong when a
 * teammate is still working in it. A hide only ever affects the one user, and
 * leaves the session running and visible for everyone else.
 *
 * The server does no lifecycle logic (same split as snoozes): the frontend
 * resurfaces a hidden row while any of its sessions is blocked on a question, and
 * consumes the entry when it does, so a hide can never swallow work that needs
 * you.
 */

import { userStore } from "./shared/user-store";

/** Row key → ISO timestamp of when the user hid it. */
export type Hides = Record<string, string>;

/** Keep only string-key entries whose value parses as a date. */
function clean(input: unknown): Hides {
  const out: Hides = {};
  if (input && typeof input === "object") {
    for (const [key, at] of Object.entries(input as Record<string, unknown>)) {
      if (
        typeof key === "string" &&
        key.length > 0 &&
        key.length <= 128 &&
        typeof at === "string" &&
        !Number.isNaN(Date.parse(at))
      ) {
        out[key] = at;
      }
    }
  }
  return out;
}

const store = userStore<Hides>({ name: "hides", field: "hides", clean });

export function getHides(user: string): Hides {
  return store.get(user);
}

/** Replace a user's hides (validated). Returns the stored map. */
export function setHides(user: string, hides: unknown): Hides {
  return store.set(user, hides);
}
