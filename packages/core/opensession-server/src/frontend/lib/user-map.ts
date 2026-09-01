// Factory for the per-user MAPS that follow you across devices: sidebar
// hides, snoozes, lanes and tab colors. Each is a `Record<string, V>` held
// server-side under the UserPicker name, mirrored in an in-memory cache so the
// public API stays synchronous.
//
// Writes send a DELTA: the keys this client just set, and the keys it just
// dropped, never the whole map. That is the invariant the rest of this file
// exists to protect, and it was learned the hard way: while writes were whole
// maps, a person with the app open in two tabs (or the web app and a native
// client) had two caches that each believed they were the whole truth, and
// neither was told when the other wrote. The second writer's PUT deleted every
// entry the first had made since it loaded. For snoozes that looked like a
// workspace parked for "Someday" waking up on its own: nothing expired it,
// another client had simply overwritten the map without it. Two clients
// editing different keys must not be able to erase each other.
//
// The rest of the lifecycle follows from the same concern:
//
//   - A failed GET commits nothing and leaves the store unhydrated. A server
//     restart or a 502 must not let the cache masquerade as the user's map.
//   - EVERY write is held as an intent until its PUT is confirmed, and a
//     hydration re-applies whatever is still outstanding on top of the server
//     map. So a GET that overtakes an in-flight write can't briefly revert the
//     row, and a write made before the map ever landed still persists.
//   - A hydration that resolves after a user switch, or after a newer
//     hydration started, is discarded.
//   - The tab re-hydrates when it becomes visible again, so a window left open
//     for a day converges with what you did on your phone instead of showing
//     yesterday's map until a reload.
//
// lib/user-pref.ts is the scalar counterpart (one value, localStorage-backed);
// lib/pins.ts stays hand-rolled because it is an ordered array with a legacy
// localStorage migration and a server-push path.
import { getCurrentUser } from "../components/UserPicker";
import { whenCurrentUserReady } from "./auth-ready";

const USER_CHANGE_EVENT = "opensession-user-changed";

/** What a write asks the server to change. Absent keys are left alone. */
export interface MapDelta<V> {
  set: Record<string, V>;
  remove: string[];
}

/**
 * One outstanding write. `value` absent means the key was removed. `seq`
 * identifies this exact write so a confirmation only clears the intent it
 * actually carried, never a newer one made while the PUT was in flight.
 */
interface Intent<V> {
  value?: V;
  seq: number;
}

export interface UserMap<V> {
  /** Synchronous read of the cached map. */
  get: () => Record<string, V>;
  /**
   * Apply a change: the mutator gets the current map and returns the next one,
   * or null to mean "nothing changed" (no event, no write). Returns the map in
   * effect afterwards.
   */
  update: (
    mutate: (current: Record<string, V>) => Record<string, V> | null,
  ) => Record<string, V>;
  /** Subscribe to changes (local writes and hydrations). */
  onChanged: (handler: () => void) => () => void;
  /** Whether the cache reflects the server map for the current user. */
  ready: () => boolean;
  /** Pull the server map in. Runs on load and user switch; exported for tests. */
  hydrate: (user?: string) => Promise<void>;
}

export function makeUserMap<V>(opts: {
  /** Window event dispatched whenever the map changes. */
  changeEvent: string;
  fetchMap: (user: string) => Promise<Record<string, V>>;
  /** Persist only what changed. Must reject on failure so the intent is kept. */
  saveDelta: (user: string, delta: MapDelta<V>) => Promise<unknown>;
  /** Defaults to the UserPicker name; injectable for tests. */
  currentUser?: () => string;
  /** Delay before retrying a hydration that failed. */
  retryMs?: number;
}): UserMap<V> {
  const currentUser = opts.currentUser ?? getCurrentUser;
  const retryMs = opts.retryMs ?? 5_000;

  let cache: Record<string, V> = {};
  let hydratedFor: string | null = null;
  let hydrationVersion = 0;
  let hydrating = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  // Writes not yet confirmed by the server, keyed by user so a switch
  // mid-flight can't carry one person's intent onto another's map.
  const pendingIntents = new Map<string, Record<string, Intent<V>>>();
  // One request at a time per user preserves this client's mutation order.
  // Without it, two fetches can reach the server in reverse order and leave
  // the older value behind.
  const savingUsers = new Set<string>();
  // A GET that began before a write was confirmed may still carry the old map.
  // Advancing this counter on confirmation lets hydrate discard that response.
  const confirmedVersions = new Map<string, number>();

  // Capability check, not just `typeof window`: test runners can leave a bare
  // `window` global without DOM methods, and these modules must stay
  // importable outside a browser (their domain helpers are unit-tested).
  function hasDom(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    );
  }

  function emit(): void {
    if (
      typeof window === "undefined" ||
      typeof window.dispatchEvent !== "function"
    )
      return;
    window.dispatchEvent(new Event(opts.changeEvent));
  }

  function get(): Record<string, V> {
    return cache;
  }

  function ready(): boolean {
    return hydratedFor === currentUser();
  }

  /** Record what this write changed, so it survives until the server has it. */
  function recordIntents(
    user: string,
    prev: Record<string, V>,
    next: Record<string, V>,
  ): void {
    const intents = pendingIntents.get(user) ?? {};
    const written: Record<string, Intent<V>> = {};
    for (const [key, value] of Object.entries(next))
      if (prev[key] !== value) written[key] = { value, seq: ++seq };
    for (const key of Object.keys(prev))
      if (!(key in next)) written[key] = { seq: ++seq };
    for (const [key, intent] of Object.entries(written)) intents[key] = intent;
    pendingIntents.set(user, intents);
  }

  /** Drop the intents a confirmed write carried, keeping any newer ones. */
  function confirm(user: string, written: Record<string, Intent<V>>): void {
    const intents = pendingIntents.get(user);
    if (intents) {
      for (const [key, intent] of Object.entries(written))
        if (intents[key]?.seq === intent.seq) delete intents[key];
      if (Object.keys(intents).length === 0) pendingIntents.delete(user);
    }
    confirmedVersions.set(user, (confirmedVersions.get(user) ?? 0) + 1);
  }

  function deltaOf(written: Record<string, Intent<V>>): MapDelta<V> {
    const set: Record<string, V> = {};
    const remove: string[] = [];
    for (const [key, intent] of Object.entries(written)) {
      if ("value" in intent) set[key] = intent.value as V;
      else remove.push(key);
    }
    return { set, remove };
  }

  function flush(user: string): void {
    if (savingUsers.has(user)) return;
    const intents = pendingIntents.get(user);
    if (!intents || Object.keys(intents).length === 0) return;
    // Snapshot the exact per-key sequence numbers this request carries. Newer
    // writes replace entries in pendingIntents but cannot be confirmed by this
    // older request.
    const written = { ...intents };
    savingUsers.add(user);
    void Promise.resolve(opts.saveDelta(user, deltaOf(written)))
      .then(() => {
        confirm(user, written);
        savingUsers.delete(user);
        // A mutation made while this request was in flight waits its turn.
        flush(user);
      })
      // Keep the intent. The next mutation or hydration retries it rather
      // than letting a network blip erase the local choice on reload.
      .catch(() => savingUsers.delete(user));
  }

  function update(
    mutate: (current: Record<string, V>) => Record<string, V> | null,
  ): Record<string, V> {
    const next = mutate(cache);
    if (!next || next === cache) return cache;
    const user = currentUser();
    recordIntents(user, cache, next);
    cache = next;
    emit();
    // Unhydrated, this cache is not yet the user's map. hydrate() merges the
    // intent onto the server map and persists it from there.
    if (hydratedFor === user) flush(user);
    else if (!hydrating) void hydrate(user);
    return next;
  }

  function scheduleRetry(user: string): void {
    if (!hasDom()) return;
    clearTimeout(retry);
    const handle = setTimeout(() => {
      retry = undefined;
      if (currentUser() === user && hydratedFor !== user) void hydrate(user);
    }, retryMs);
    retry = handle;
    // Never hold a test runner or a script open on the retry.
    (handle as unknown as { unref?: () => void }).unref?.();
  }

  async function hydrate(user: string = currentUser()): Promise<void> {
    const version = ++hydrationVersion;
    const confirmedAtStart = confirmedVersions.get(user) ?? 0;
    hydrating = true;
    let server: Record<string, V>;
    try {
      server = await opts.fetchMap(user);
    } catch {
      // Offline, or the server is restarting: keep the cache and stay
      // unhydrated, so no write can mistake it for the user's map.
      hydrating = false;
      scheduleRetry(user);
      return;
    }
    hydrating = false;
    // A newer hydration, a user switch, or a write confirmed after this GET
    // began wins. In the last case the response may be the pre-write map.
    if (
      version !== hydrationVersion ||
      currentUser() !== user ||
      (confirmedVersions.get(user) ?? 0) !== confirmedAtStart
    )
      return;
    // Anything still outstanding goes back on top: the server map may have
    // been read before our write landed, and it is never authoritative about
    // a change it hasn't confirmed yet.
    const outstanding = pendingIntents.get(user) ?? {};
    const next: Record<string, V> = { ...server };
    for (const [key, intent] of Object.entries(outstanding)) {
      if ("value" in intent) next[key] = intent.value as V;
      else delete next[key];
    }
    clearTimeout(retry);
    retry = undefined;
    cache = next;
    hydratedFor = user;
    emit();
    // A write made before the map landed, or one whose PUT failed, still
    // needs sending. Confirmed writes are already gone from the map.
    flush(user);
  }

  function onChanged(handler: () => void): () => void {
    if (!hasDom()) return () => {};
    window.addEventListener(opts.changeEvent, handler);
    return () => window.removeEventListener(opts.changeEvent, handler);
  }

  if (hasDom()) {
    whenCurrentUserReady((user) => void hydrate(user));
    window.addEventListener(USER_CHANGE_EVENT, () => void hydrate());
    // A tab left open all day is the one most likely to be showing a map
    // another device has moved on from.
    if (typeof document !== "undefined" && document.addEventListener)
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void hydrate();
      });
  }

  return { get, update, onChanged, ready, hydrate };
}
