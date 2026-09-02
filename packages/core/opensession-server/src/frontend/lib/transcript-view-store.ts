import type { TranscriptEntry } from "./types";
import { orderTranscriptEntries } from "./transcript-state";

type Listener = () => void;
type Updater =
  | TranscriptEntry[]
  | ((previous: TranscriptEntry[]) => TranscriptEntry[]);

/**
 * Normalized transcript projection. Live upserts are O(k) and publish at most
 * once per animation frame; snapshots preserve entry object identity for
 * untouched turns so memoized history stays cold.
 */
export class TranscriptViewStore {
  private byId = new Map<string, TranscriptEntry>();
  private orderedIds: string[] = [];
  private snapshot: TranscriptEntry[] = [];
  private listeners = new Set<Listener>();
  private frame: number | null = null;
  private hasUnsequenced = false;
  private lastSeq = 0;

  constructor(entries: TranscriptEntry[] = []) {
    this.replace(entries, false);
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => this.snapshot;

  replace(entries: TranscriptEntry[], notify = true, v2 = false) {
    this.cancelFrame();
    this.byId.clear();
    this.orderedIds = [];
    for (const entry of v2 ? orderTranscriptEntries(entries) : entries) {
      if (!this.byId.has(entry.id)) this.orderedIds.push(entry.id);
      this.byId.set(entry.id, entry);
    }
    this.refreshOrderingMetadata();
    this.publish(notify);
  }

  merge(entries: TranscriptEntry[], v2 = false, immediate = false) {
    if (entries.length === 0) return;
    let changed = false;
    let needsOrder = false;
    for (const entry of entries) {
      const current = this.byId.get(entry.id);
      if (
        current?.changeSeq !== undefined &&
        entry.changeSeq !== undefined &&
        entry.changeSeq < current.changeSeq
      )
        continue;
      if (!current) {
        this.orderedIds.push(entry.id);
        if (
          v2 &&
          (entry.seq === undefined ||
            this.hasUnsequenced ||
            entry.seq < this.lastSeq)
        )
          needsOrder = true;
        if (entry.seq === undefined) this.hasUnsequenced = true;
        else this.lastSeq = Math.max(this.lastSeq, entry.seq);
      } else if (v2 && current.seq !== entry.seq) {
        // Live tool results arrive without seq, then the durable append fills it
        // in. Reorder that existing id now, rather than leaving the result at
        // whichever end of the current turn its live frame first occupied.
        needsOrder = true;
      }
      this.byId.set(entry.id, entry);
      changed = true;
    }
    if (!changed) return;
    if (v2 && needsOrder) this.orderV2();
    this.commit(immediate);
  }

  /** Merge one server range, whose durable rows are ordered by immutable seq.
   * Splice its bounded seq window, or linearly rebuild a mixed decoration spine,
   * instead of sorting every loaded entry again for each hydration response. */
  mergeRange(entries: TranscriptEntry[], immediate = false) {
    if (entries.length === 0) return;
    if (entries.some((entry) => entry.seq === undefined)) {
      this.merge(entries, true, immediate);
      return;
    }

    let canSplice = !this.hasUnsequenced;
    const acceptedIds = new Set<string>();
    const arrivalPositions = new Map<string, number>();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const current = this.byId.get(entry.id);
      if (
        current?.changeSeq !== undefined &&
        entry.changeSeq !== undefined &&
        entry.changeSeq < current.changeSeq
      )
        continue;
      // Durable seq is immutable. Keep the general rebuild as a safe fallback
      // if a malformed replacement ever violates that invariant.
      if (current?.seq !== undefined && current.seq !== entry.seq)
        canSplice = false;
      this.byId.set(entry.id, entry);
      acceptedIds.add(entry.id);
      if (!arrivalPositions.has(entry.id))
        arrivalPositions.set(entry.id, this.orderedIds.length + index);
    }
    if (acceptedIds.size === 0) return;

    const rangeIds = [...acceptedIds].sort(
      (a, b) => this.byId.get(a)!.seq! - this.byId.get(b)!.seq!,
    );
    if (canSplice) {
      const firstSeq = this.byId.get(rangeIds[0]!)!.seq!;
      const lastSeq = this.byId.get(rangeIds[rangeIds.length - 1]!)!.seq!;
      let low = 0;
      let high = this.orderedIds.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.byId.get(this.orderedIds[middle]!)!.seq! < firstSeq)
          low = middle + 1;
        else high = middle;
      }
      const start = low;
      high = this.orderedIds.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.byId.get(this.orderedIds[middle]!)!.seq! <= lastSeq)
          low = middle + 1;
        else high = middle;
      }
      const end = low;
      const existingIds = this.orderedIds
        .slice(start, end)
        .filter((id) => !acceptedIds.has(id));
      const mergedIds: string[] = [];
      let existingIndex = 0;
      let rangeIndex = 0;
      while (
        existingIndex < existingIds.length ||
        rangeIndex < rangeIds.length
      ) {
        const existingId = existingIds[existingIndex];
        const rangeId = rangeIds[rangeIndex];
        if (
          rangeId === undefined ||
          (existingId !== undefined &&
            this.byId.get(existingId)!.seq! <= this.byId.get(rangeId)!.seq!)
        ) {
          mergedIds.push(existingId!);
          existingIndex++;
        } else {
          mergedIds.push(rangeId);
          rangeIndex++;
        }
      }
      this.orderedIds.splice(start, end - start, ...mergedIds);
      this.lastSeq = Math.max(this.lastSeq, lastSeq);
      this.commit(immediate);
      return;
    }

    const previousPositions = new Map(
      this.orderedIds.map((id, index) => [id, index]),
    );
    type SequencedId = { id: string; seq: number; position: number };
    const existingSpine: SequencedId[] = [];
    const decorations: string[] = [];
    for (let index = 0; index < this.orderedIds.length; index++) {
      const id = this.orderedIds[index]!;
      if (acceptedIds.has(id)) continue;
      const entry = this.byId.get(id);
      if (!entry) continue;
      if (entry.seq === undefined) decorations.push(id);
      else existingSpine.push({ id, seq: entry.seq, position: index });
    }
    const rangeSpine = rangeIds.map((id): SequencedId => ({
      id,
      seq: this.byId.get(id)!.seq!,
      position: previousPositions.get(id) ?? arrivalPositions.get(id)!,
    }));

    const sequencedIds: string[] = [];
    let existingIndex = 0;
    let rangeIndex = 0;
    while (
      existingIndex < existingSpine.length ||
      rangeIndex < rangeSpine.length
    ) {
      const existing = existingSpine[existingIndex];
      const incoming = rangeSpine[rangeIndex];
      if (
        incoming === undefined ||
        (existing !== undefined &&
          (existing.seq < incoming.seq ||
            (existing.seq === incoming.seq &&
              existing.position < incoming.position)))
      ) {
        sequencedIds.push(existing!.id);
        existingIndex++;
      } else {
        sequencedIds.push(incoming.id);
        rangeIndex++;
      }
    }

    // Decorations have no seq. The existing canonical order already sorts
    // them by timestamp, so placing them around the new seq spine is linear.
    const orderedIds: string[] = [];
    let seqIndex = 0;
    for (const id of decorations) {
      const decorationTime = this.entryTime(this.byId.get(id)!);
      while (
        seqIndex < sequencedIds.length &&
        this.entryTime(this.byId.get(sequencedIds[seqIndex]!)!) <=
          decorationTime
      ) {
        orderedIds.push(sequencedIds[seqIndex++]!);
      }
      orderedIds.push(id);
    }
    while (seqIndex < sequencedIds.length)
      orderedIds.push(sequencedIds[seqIndex++]!);

    this.orderedIds = orderedIds;
    this.refreshOrderingMetadata();
    this.commit(immediate);
  }

  prepend(entries: TranscriptEntry[], v2 = false) {
    if (entries.length === 0) return;
    if (v2) {
      this.merge(entries, true);
      return;
    }
    let changed = false;
    for (const entry of entries) {
      const current = this.byId.get(entry.id);
      if (
        current?.changeSeq !== undefined &&
        entry.changeSeq !== undefined &&
        entry.changeSeq < current.changeSeq
      )
        continue;
      if (!current) {
        this.orderedIds.push(entry.id);
      }
      this.byId.set(entry.id, entry);
      changed = true;
    }
    if (!changed) return;
    this.orderedIds.sort(
      (a, b) =>
        new Date(this.byId.get(a)!.timestamp).getTime() -
        new Date(this.byId.get(b)!.timestamp).getTime(),
    );
    this.refreshOrderingMetadata();
    this.schedulePublish();
  }

  update(updater: Updater) {
    const current = this.orderedIds
      .map((id) => this.byId.get(id))
      .filter((entry): entry is TranscriptEntry => Boolean(entry));
    this.replace(Array.isArray(updater) ? updater : updater(current));
  }

  private commit(immediate: boolean) {
    if (immediate) {
      this.cancelFrame();
      this.publish();
    } else {
      this.schedulePublish();
    }
  }

  private entryTimes = new WeakMap<TranscriptEntry, number>();
  private entryTime(entry: TranscriptEntry) {
    const cached = this.entryTimes.get(entry);
    if (cached !== undefined) return cached;
    const parsed = Date.parse(entry.timestamp);
    const value = Number.isFinite(parsed) ? parsed : 0;
    this.entryTimes.set(entry, value);
    return value;
  }

  private schedulePublish() {
    if (this.frame !== null) return;
    if (typeof requestAnimationFrame === "undefined") {
      this.publish();
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.publish();
    });
  }

  private publish(notify = true) {
    this.snapshot = this.orderedIds
      .map((id) => this.byId.get(id))
      .filter((entry): entry is TranscriptEntry => Boolean(entry));
    if (notify) for (const listener of this.listeners) listener();
  }

  private orderV2() {
    this.orderedIds = orderTranscriptEntries(
      this.orderedIds
        .map((id) => this.byId.get(id))
        .filter((entry): entry is TranscriptEntry => Boolean(entry)),
    ).map((entry) => entry.id);
    this.refreshOrderingMetadata();
  }

  private refreshOrderingMetadata() {
    this.hasUnsequenced = false;
    this.lastSeq = 0;
    for (const id of this.orderedIds) {
      const seq = this.byId.get(id)?.seq;
      if (seq === undefined) this.hasUnsequenced = true;
      else this.lastSeq = Math.max(this.lastSeq, seq);
    }
  }

  private cancelFrame() {
    if (this.frame !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.frame);
    }
    this.frame = null;
  }
}
