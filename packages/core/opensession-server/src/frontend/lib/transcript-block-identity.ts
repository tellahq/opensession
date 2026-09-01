type TranscriptEntryIdentity = { id: string };
type TranscriptArrivalEntry = TranscriptEntryIdentity & {
  type: string;
  sourceMessageIds?: string[];
};
type TranscriptArrivalItem = {
  entryIds: string[];
  arrivalAliases?: string[];
  animateArrival?: boolean;
};

/** Model switches are timeline decorations, not rows whose later displacement
 * carries meaning. Their immediate arrival may fade in, but transcript
 * hydration must never glide an already-settled divider vertically. */
export function shouldAnimateTranscriptEntryPosition(entry: {
  id: string;
}): boolean {
  return !entry.id.startsWith("model-switch-");
}

/** Keep one React/virtualizer identity while a locally-created user row receives
 * its durable transcript id. For a batched row, the first source owns the
 * mounted bubble that survives the merge. */
export function transcriptEntryMountKey(entry: TranscriptArrivalEntry): string {
  if (entry.type !== "user") return entry.id;
  const id = entry.sourceMessageIds?.[0] ?? entry.id;
  return id.startsWith("outbox-") ? id : `outbox-${id}`;
}

/** Identities used by the optimistic user row before its durable replacement
 * receives a transcript block or indexed-range key. */
export function transcriptArrivalAliases(
  entries: readonly TranscriptArrivalEntry[],
): string[] | undefined {
  const aliases = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "user") continue;
    for (const id of [entry.id, ...(entry.sourceMessageIds ?? [])]) {
      aliases.add(id.startsWith("outbox-") ? id : `outbox-${id}`);
    }
  }
  return aliases.size ? [...aliases] : undefined;
}

/** A new outer block is reconciliation rather than an arrival when it contains
 * an entry that was already painted, or when one of its optimistic aliases was
 * already painted. Transcript/index refreshes can rebuild a range under a new
 * block key without adding any conversation content; the durable entry ids are
 * the stable identity across that rebuild. */
export function shouldAnimateTranscriptItemArrival(
  item: TranscriptArrivalItem,
  mountedEntryIds: ReadonlySet<string>,
): boolean {
  return (
    item.animateArrival !== false &&
    !(
      item.entryIds.some((id) => mountedEntryIds.has(id)) ||
      item.arrivalAliases?.some((alias) => mountedEntryIds.has(alias))
    )
  );
}

/**
 * A mounted live turn keeps the identity of its first entry while later steps
 * append. Indexed ranges provide their stable structural key too: payload
 * slices can prepend older steps, so neither end entry alone survives both
 * hydration and live appends.
 */
export function turnMountKey(
  entries: readonly TranscriptEntryIdentity[],
  rangeKey?: string,
): string {
  const first = entries[0];
  if (!first) throw new Error("Turn blocks require at least one entry");
  return rangeKey ? `${rangeKey}#turn` : first.id;
}

/** How many tail positions count as the live edge for arrival animation. A
 * turn block, its answer, and its footer can mount in one build, so the window
 * covers the trio; anything further back is history, not an arrival. */
const TAIL_ARRIVAL_WINDOW = 3;

/**
 * Keys of blocks that mounted at the live edge since the previous build, and so
 * should play the arrival fade. The first build (null previous) seeds without
 * animating: opening a session or hydrating history is not an arrival.
 */
export function newTailBlockKeys(
  previous: ReadonlySet<string> | null,
  keys: readonly string[],
): string[] {
  if (!previous) return [];
  const fresh: string[] = [];
  for (
    let index = Math.max(0, keys.length - TAIL_ARRIVAL_WINDOW);
    index < keys.length;
    index++
  ) {
    const key = keys[index];
    if (key && !previous.has(key)) fresh.push(key);
  }
  return fresh;
}

/**
 * History hydration can prepend entries to a partially loaded turn. Its last
 * entry remains stable through that operation, so the scroll hold anchors here.
 */
export function turnScrollAnchor(
  entries: readonly TranscriptEntryIdentity[],
): string {
  const last = entries[entries.length - 1];
  if (!last) throw new Error("Turn blocks require at least one entry");
  return `${last.id}#turn`;
}
