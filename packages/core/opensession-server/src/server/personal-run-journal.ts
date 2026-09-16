/**
 * Private gateway run journal.
 *
 * A run bound to a personal repository is journaled here, in the session
 * kernel's central catalog, never in the shared `active-runs.json`. The
 * kernel worker owns persistence: every mutation is an awaited compare-and-set
 * on the row revision, and every synchronous read comes from the memory
 * projection this module hydrates from the catalog. The gateway thread never
 * touches a file or SQLite for these records.
 *
 * The projection is bounded by live private work: hydration pages only rows
 * that currently exist (`page_live`, served from the worker's partial live
 * index), so accumulated tombstones cost nothing. Boot hydrates it before any
 * listener or adoption sweep; a production read before hydration is a
 * boot-order bug and fails loudly instead of reporting a private session as
 * idle.
 *
 * A stored row this process cannot decode is evidence that a private run may
 * be busy, and its lost session mapping cannot be reconstructed from the key
 * alone: a projection published without it would let startup cleanup infer
 * a missing owner for that session. Wherever such a row is discovered, at
 * hydration or adopted from a conflicting writer at run time, the projection
 * is withdrawn: readiness drops, every read fails closed, the row is named
 * for the operator and never erased, and readiness returns only through a
 * complete successful rehydration after the row is repaired.
 *
 * Detached run hosts (`OPENSESSION_RUN_JOURNAL`) keep their own per-host file
 * through run-journal.ts and never use this module.
 */
import { randomUUID } from "node:crypto";
import {
  personalRunConsumerKey,
  snapshotPersonalRunConsumer,
  type PersonalRunConsumer,
} from "./personal-run-consumers";
import type { ActiveRunRecord, QuarantinedRun } from "./run-journal";
import { sessionCatalogDocument } from "./session-kernel/kernel";

const ACTIVE_NAMESPACE = "personal_active_runs_v1";
const QUARANTINE_NAMESPACE = "personal_run_quarantine_v1";
const PAGE_LIMIT = 1_000;
const MAX_KEY_BYTES = 512;
const CAS_ATTEMPTS = 32;

interface Entry {
  /** Stored document text, exactly as committed (the CAS base). */
  value: string;
  rev: number;
  /** Decoded record. A row this process cannot read never becomes an entry:
   * discovering one withdraws the whole projection instead. */
  record: ActiveRunRecord;
  /** Exact physical consumer key, or undefined for a private record that
   * lost part of its identity: busy evidence that can never pass recovery. */
  consumerKey: string | undefined;
}

interface JournalState {
  ready: boolean;
  hydrating: Promise<void> | null;
  entries: Map<string, Entry>;
  /** Consumer keys whose retirement was physically confirmed but whose row
   * is not yet durably tombstoned. Pruned as soon as no projected row names
   * the consumer, so it holds only unresolved suppression obligations. */
  confirmed: Set<string>;
  serial: Map<string, Promise<unknown>>;
  version: number;
}

// Parked on globalThis so a hot reload keeps the hydrated projection; the
// boot guard does not hydrate twice.
const journalGlobal = globalThis as typeof globalThis & {
  __personalRunJournal?: JournalState;
};

function freshState(): JournalState {
  return {
    ready: false,
    hydrating: null,
    entries: new Map(),
    confirmed: new Set(),
    serial: new Map(),
    version: 0,
  };
}

function state(): JournalState {
  return (journalGlobal.__personalRunJournal ??= freshState());
}

/** The gateway journals private runs here; a detached host journals to its
 * own per-host legacy file and never reaches the catalog. */
export function personalRunJournalApplicable(): boolean {
  return !process.env.OPENSESSION_RUN_JOURNAL;
}

export function personalRunJournalReady(): boolean {
  return state().ready;
}

/** Monotonic per process; bumps on every projection change. */
export function personalRunJournalVersion(): number {
  return state().version;
}

function validateRunKey(runKey: string): void {
  if (
    typeof runKey !== "string" ||
    !runKey ||
    runKey.includes("\0") ||
    Buffer.byteLength(runKey) > MAX_KEY_BYTES
  )
    throw new Error("Invalid private run journal key");
}

/** The exact physical identity a private record names. Throws for a record
 * that lost any part of it: such a record is evidence, never an owner. */
export function personalRunJournalConsumer(
  record: ActiveRunRecord,
): PersonalRunConsumer {
  if (!record.personalRepo || !record.hostId || !record.osSessionId)
    throw new Error("Personal journal lacks original host identity");
  return snapshotPersonalRunConsumer({
    runKey: record.runKey,
    hostId: record.hostId,
    sessionId: record.osSessionId,
    binding: record.personalRepo,
  });
}

function consumerKeyOf(record: ActiveRunRecord): string | undefined {
  try {
    return personalRunConsumerKey(personalRunJournalConsumer(record));
  } catch {
    return undefined;
  }
}

/** Same logical run lineage. Shared records compare by first journal time and
 * session; private records additionally require the exact physical identity
 * (host, session, immutable binding revision), so a successor host or a
 * changed binding is a different owner even under the same run alias. */
export function sameJournalLineage(
  current: ActiveRunRecord,
  expected: ActiveRunRecord,
): boolean {
  if (
    (current.firstJournaledAt || current.startedAt) !==
      (expected.firstJournaledAt || expected.startedAt) ||
    current.osSessionId !== expected.osSessionId
  )
    return false;
  if (!current.personalRepo && !expected.personalRepo) return true;
  try {
    return (
      personalRunConsumerKey(personalRunJournalConsumer(current)) ===
      personalRunConsumerKey(personalRunJournalConsumer(expected))
    );
  } catch {
    return false;
  }
}

function decodeRow(key: string, value: string): ActiveRunRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as ActiveRunRecord).runKey === key &&
      typeof (parsed as ActiveRunRecord).cwd === "string" &&
      typeof (parsed as ActiveRunRecord).startedAt === "string" &&
      !!(parsed as ActiveRunRecord).personalRepo
    )
      return parsed as ActiveRunRecord;
  } catch {}
  return undefined;
}

/** Withdraw the projection over rows this process cannot read. Reads fail
 * closed from here on; the next ensurePersonalRunJournalReady() rehydrates
 * and rejects again until an operator repairs the rows, which stay in the
 * catalog untouched. */
function withdrawReadiness(current: JournalState, unreadable: string[]): Error {
  const keys = unreadable.join(", ");
  current.ready = false;
  current.entries = new Map();
  current.version++;
  console.error(
    `[runner] Private run journal has ${unreadable.length} unreadable row(s); readiness withdrawn until repaired: ${keys}`,
  );
  return new Error(
    `Private run journal has unreadable rows; repair before boot continues: ${keys}`,
  );
}

/** Drop confirmations whose obligation is resolved: no projected row names
 * the consumer any more, so nothing remains to suppress. A row for that
 * consumer cannot come back: its retirement is durable in the authority,
 * which every private admission consults before it writes. */
function pruneConfirmed(current: JournalState): void {
  if (!current.confirmed.size) return;
  const named = new Set<string>();
  for (const entry of current.entries.values())
    if (entry.consumerKey !== undefined) named.add(entry.consumerKey);
  for (const key of current.confirmed)
    if (!named.has(key)) current.confirmed.delete(key);
}

/** Apply one committed row to the projection. Throws, after withdrawing
 * readiness, when the committed text cannot be read. */
function project(
  key: string,
  row: { value: string | null; rev: number } | null,
): void {
  const current = state();
  if (!row || row.value === null) current.entries.delete(key);
  else {
    const record = decodeRow(key, row.value);
    if (!record) throw withdrawReadiness(current, [key]);
    current.entries.set(key, {
      value: row.value,
      rev: row.rev,
      record,
      consumerKey: consumerKeyOf(record),
    });
  }
  current.version++;
  pruneConfirmed(current);
}

async function hydrate(): Promise<void> {
  const entries = new Map<string, Entry>();
  const unreadable: string[] = [];
  let afterKey = "";
  for (;;) {
    const rows = await sessionCatalogDocument({
      op: "page_live",
      namespace: ACTIVE_NAMESPACE,
      afterKey,
      limit: PAGE_LIMIT,
    });
    const last = rows.at(-1);
    if (!last) break;
    for (const row of rows) {
      if (row.value === null) continue;
      const record = decodeRow(row.key, row.value);
      if (!record) {
        unreadable.push(row.key);
        continue;
      }
      entries.set(row.key, {
        value: row.value,
        rev: row.rev,
        record,
        consumerKey: consumerKeyOf(record),
      });
    }
    afterKey = last.key;
  }
  // A row this process cannot read may name a busy private session whose
  // identity is lost with it. Publishing without it would report that
  // session idle, so readiness fails closed until an operator repairs the
  // row (which stays in the catalog untouched) and hydration is retried.
  const current = state();
  if (unreadable.length) throw withdrawReadiness(current, unreadable);
  // Publish only a complete snapshot: a failed page above rejects before
  // this point and leaves the previous readiness untouched.
  current.entries = entries;
  current.ready = true;
  current.version++;
  pruneConfirmed(current);
}

/** Hydrate the projection once from the catalog. Boot awaits this before any
 * listener, route, or adoption sweep; private mutations await it themselves.
 * A failed hydration (kernel unavailable, or an unreadable stored row) is
 * retried by the next call and leaves reads unready meanwhile. */
export function ensurePersonalRunJournalReady(): Promise<void> {
  const current = state();
  if (current.ready) return Promise.resolve();
  if (!current.hydrating) {
    current.hydrating = hydrate().finally(() => {
      current.hydrating = null;
    });
  }
  return current.hydrating;
}

function readyEntries(): Map<string, Entry> {
  const current = state();
  if (current.ready) return current.entries;
  // Bun tests run without the boot sequence: shared-only fixtures read an
  // empty private projection until a private operation hydrates it. Production
  // fails closed: an unhydrated read would report a private session idle.
  if (process.env.NODE_ENV === "test") return current.entries;
  throw new Error(
    "Private run journal is not hydrated; boot must await ensurePersonalRunJournalReady()",
  );
}

function visible(entry: Entry): boolean {
  return (
    entry.consumerKey === undefined || !state().confirmed.has(entry.consumerKey)
  );
}

/** True once this process confirmed the exact consumer's retirement and its
 * tombstone is still pending: the record no longer counts as an owner. */
export function personalRunRecordSuppressed(record: ActiveRunRecord): boolean {
  const key = consumerKeyOf(record);
  return key !== undefined && state().confirmed.has(key);
}

/** Synchronous snapshot of every private record still counting as busy. */
export function personalRunRecords(): ActiveRunRecord[] {
  const records: ActiveRunRecord[] = [];
  for (const entry of readyEntries().values())
    if (visible(entry)) records.push(structuredClone(entry.record));
  return records;
}

/** The stored copy for one key (including a boot claim), or undefined. */
export function personalRunRecord(runKey: string): ActiveRunRecord | undefined {
  const entry = readyEntries().get(runKey);
  return entry && visible(entry) ? structuredClone(entry.record) : undefined;
}

/** Whether a private row occupies this key. */
export function personalRunKeyHeld(runKey: string): boolean {
  const entry = readyEntries().get(runKey);
  return !!entry && visible(entry);
}

export function hasPersonalRunFor(
  ...ids: Array<string | null | undefined>
): boolean {
  const wanted = ids.filter((id): id is string => !!id);
  if (!wanted.length) return false;
  for (const [key, entry] of readyEntries()) {
    if (!visible(entry)) continue;
    if (wanted.includes(key)) return true;
    const record = entry.record;
    if (
      (record.osSessionId && wanted.includes(record.osSessionId)) ||
      (record.claudeSessionId && wanted.includes(record.claudeSessionId))
    )
      return true;
  }
  return false;
}

async function serial<T>(runKey: string, run: () => Promise<T>): Promise<T> {
  const current = state();
  const previous = current.serial.get(runKey);
  const next = (previous ? previous.catch(() => {}) : Promise.resolve()).then(
    run,
  );
  current.serial.set(runKey, next);
  try {
    return await next;
  } finally {
    if (current.serial.get(runKey) === next) current.serial.delete(runKey);
  }
}

/**
 * Compare-and-set one private record. `mutate` sees the committed row (never
 * a pre-await copy) and returns the next record, `null` to tombstone it, or
 * `undefined` to leave it untouched. A revision conflict re-runs `mutate` on
 * the stored truth, so every ownership guard is evaluated against what a
 * concurrent successor actually committed. Resolves with what was written.
 */
export async function mutatePersonalRunRecord(
  runKey: string,
  mutate: (
    current: ActiveRunRecord | undefined,
  ) => ActiveRunRecord | null | undefined,
): Promise<ActiveRunRecord | null | undefined> {
  validateRunKey(runKey);
  if (!personalRunJournalApplicable())
    throw new Error("Private run journal is unavailable on a detached host");
  return serial(runKey, async () => {
    await ensurePersonalRunJournalReady();
    const projected = state().entries.get(runKey);
    let row: { value: string | null; rev: number } | null = projected
      ? { value: projected.value, rev: projected.rev }
      : null;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      // The base row was projected, so it decodes; an adopted conflicting row
      // that does not has already withdrawn readiness in project().
      const stored =
        row && row.value !== null ? decodeRow(runKey, row.value) : undefined;
      if (row && row.value !== null && !stored)
        throw withdrawReadiness(state(), [runKey]);
      const next = mutate(stored ? structuredClone(stored) : undefined);
      if (next === undefined) return undefined;
      if (next === null && !stored) {
        project(runKey, row);
        return null;
      }
      if (next !== null && next.runKey !== runKey)
        throw new Error("Private run journal key mismatch");
      const encoded = next === null ? null : JSON.stringify(next);
      const result = await sessionCatalogDocument({
        op: "put",
        namespace: ACTIVE_NAMESPACE,
        key: runKey,
        expectedRev: row?.rev ?? null,
        value: encoded,
        requestId: randomUUID(),
      });
      if (result.status === "conflict") {
        // Another writer (a previous gateway generation during handoff)
        // committed first: adopt its truth before re-evaluating the guard.
        // An unreadable truth withdraws readiness here and rejects.
        row = result.current
          ? { value: result.current.value, rev: result.current.rev }
          : null;
        project(runKey, row);
        continue;
      }
      project(runKey, { value: encoded, rev: result.rev });
      return next;
    }
    throw new Error("Private run journal mutation contention");
  });
}

/** Physically confirmed retirement of one exact consumer: suppress its busy
 * evidence now and tombstone only the row that still names that consumer. A
 * successor host or changed binding under the same run alias is untouched.
 * The suppression is forgotten once no projected row names the consumer;
 * while a tombstone write keeps failing, it is retained. */
export async function retirePersonalRunConsumer(
  consumerKey: string,
): Promise<void> {
  const current = state();
  current.confirmed.add(consumerKey);
  current.version++;
  await ensurePersonalRunJournalReady();
  const held = [...current.entries].filter(
    ([, entry]) => entry.consumerKey === consumerKey,
  );
  for (const [runKey] of held)
    await mutatePersonalRunRecord(runKey, (stored) =>
      stored && consumerKeyOf(stored) === consumerKey ? null : undefined,
    );
  pruneConfirmed(current);
}

/** Move rejected private recovery records beside the live namespace. Each
 * quarantine row commits before its live row is tombstoned; a live row that
 * changed lineage meanwhile stays where it is. */
export async function quarantinePersonalRunRecords(
  entries: QuarantinedRun[],
): Promise<void> {
  const quarantinedAt = new Date().toISOString();
  for (const [index, entry] of entries.entries()) {
    validateRunKey(entry.run.runKey);
    const key = `${quarantinedAt}:${index}:${entry.run.runKey}`;
    const result = await sessionCatalogDocument({
      op: "put",
      namespace: QUARANTINE_NAMESPACE,
      key,
      expectedRev: null,
      value: JSON.stringify({
        ...entry.run,
        quarantinedAt,
        quarantineReason: entry.reason,
      }),
      requestId: randomUUID(),
    });
    if (result.status === "conflict")
      throw new Error("Private run quarantine key collision");
    await mutatePersonalRunRecord(entry.run.runKey, (stored) =>
      stored && sameJournalLineage(stored, entry.run) ? null : undefined,
    );
  }
}

/** Inspect quarantined private records (operator tooling and tests). */
export async function personalRunQuarantine(): Promise<
  Array<{ key: string; record: ActiveRunRecord }>
> {
  const result: Array<{ key: string; record: ActiveRunRecord }> = [];
  let afterKey = "";
  for (;;) {
    const rows = await sessionCatalogDocument({
      op: "page_live",
      namespace: QUARANTINE_NAMESPACE,
      afterKey,
      limit: PAGE_LIMIT,
    });
    const last = rows.at(-1);
    if (!last) return result;
    for (const row of rows)
      if (row.value !== null)
        result.push({ key: row.key, record: JSON.parse(row.value) });
    afterKey = last.key;
  }
}

/** Test seam: forget the projection so the next test hydrates from its own
 * kernel store. Never called by production code. */
export function __resetPersonalRunJournalForTest(): void {
  journalGlobal.__personalRunJournal = freshState();
}

/** Test seam: the unresolved suppression obligations this process holds. */
export function __personalRunJournalConfirmedForTest(): string[] {
  return [...state().confirmed];
}
