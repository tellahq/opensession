/**
 * Delta writes for the per-user maps (snoozes, hides, lanes, tab colors).
 *
 * These stores began as whole-map PUTs: the client sent its entire map on
 * every change and the server replaced what it held. That is correct only
 * while exactly one client is writing. A person with the web app open in two
 * tabs, or the web app and a native client, has two caches that each believe
 * they are the whole truth. The second writer's PUT then deletes every entry
 * the first made since it loaded. This is how a workspace snoozed for Someday
 * came back on its own: nothing expired it, another client overwrote the map
 * without it.
 *
 * A delta says only what changed: `set` for entries written and `remove` for
 * entries dropped. Values stay `unknown` here because each store's `clean()`
 * validates them on the way to disk.
 */

export interface MapDelta {
  set?: Record<string, unknown>;
  remove?: string[];
}

const MAX_OPERATIONS = 10_000;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validKey(key: string): boolean {
  return key.length > 0 && key.length <= 128 && !BLOCKED_KEYS.has(key);
}

/** Whether the body declares either delta field, valid or not. */
export function hasMapDeltaFields(body: unknown): boolean {
  return Boolean(
    body &&
    typeof body === "object" &&
    (hasOwn(body, "set") || hasOwn(body, "remove")),
  );
}

/** Validate a delta before any part of it is applied. */
export function isMapDelta(body: unknown): body is MapDelta {
  if (!isRecord(body) || !hasMapDeltaFields(body)) return false;
  const set = hasOwn(body, "set") ? body.set : {};
  const remove = hasOwn(body, "remove") ? body.remove : [];
  if (!isRecord(set) || !Array.isArray(remove)) return false;
  const setKeys = Object.keys(set);
  if (
    setKeys.length + remove.length > MAX_OPERATIONS ||
    setKeys.some((key) => !validKey(key)) ||
    remove.some((key) => typeof key !== "string" || !validKey(key))
  )
    return false;
  return true;
}

/**
 * Read either the current delta protocol or an older whole-map request. Legacy
 * maps become sets only. Their missing keys are ambiguous, so treating them as
 * removals would preserve the original cross-client data-loss bug.
 */
export function requestedMapDelta(
  body: unknown,
  legacyField: string,
): MapDelta | null {
  if (!body || typeof body !== "object") return null;
  if (hasMapDeltaFields(body)) return isMapDelta(body) ? body : null;
  const legacy = (body as Record<string, unknown>)[legacyField];
  const candidate: MapDelta = { set: legacy as Record<string, unknown> };
  return isMapDelta(candidate) ? candidate : null;
}

/**
 * Apply a validated delta to the current map. Removals happen after writes, so
 * a key in both is removed. This deterministic precedence keeps a delete from
 * being accidentally revived.
 */
export function mergeMapDelta(
  current: Record<string, unknown>,
  delta: MapDelta,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(delta.set ?? {})) next[key] = value;
  for (const key of delta.remove ?? []) delete next[key];
  return next;
}
