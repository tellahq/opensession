export type TranscriptDisclosureKind = "turn" | "tool-run" | "tool-call";

export interface TranscriptDisclosureLedger {
  read(
    kind: TranscriptDisclosureKind,
    sessionId: string | undefined,
    entryIds: readonly string[],
  ): boolean | undefined;
  write(
    kind: TranscriptDisclosureKind,
    sessionId: string | undefined,
    entryIds: readonly string[],
    expanded: boolean,
  ): void;
}

type RememberedDisclosure = {
  expanded: boolean;
  revision: number;
};

/**
 * Keeps a person's disclosure choices attached to transcript entries rather
 * than React component instances. Live appends keep their mounted turn, but
 * sparse history hydration can replace a partial group and virtualization can
 * unmount it entirely. Looking up every overlapping entry lets a replacement
 * group recover the last explicit choice; single-entry disclosures use the
 * same ledger to survive remounts.
 */
export function createTranscriptDisclosureLedger(
  maxEntries = 20_000,
): TranscriptDisclosureLedger {
  const remembered = new Map<string, RememberedDisclosure>();
  let revision = 0;

  function key(
    kind: TranscriptDisclosureKind,
    sessionId: string | undefined,
    entryId: string,
  ) {
    return `${sessionId ?? ""}\u0000${kind}\u0000${entryId}`;
  }

  return {
    read(kind, sessionId, entryIds) {
      let latest: RememberedDisclosure | undefined;
      for (const entryId of entryIds) {
        const candidate = remembered.get(key(kind, sessionId, entryId));
        if (candidate && (!latest || candidate.revision > latest.revision)) {
          latest = candidate;
        }
      }
      return latest?.expanded;
    },

    write(kind, sessionId, entryIds, expanded) {
      const next = { expanded, revision: ++revision };
      for (const entryId of entryIds) {
        const itemKey = key(kind, sessionId, entryId);
        // Refresh insertion order so the bounded ledger drops least-recently
        // changed entries rather than an actively used old turn.
        remembered.delete(itemKey);
        remembered.set(itemKey, next);
      }
      while (remembered.size > maxEntries) {
        const oldest = remembered.keys().next().value;
        if (oldest === undefined) break;
        remembered.delete(oldest);
      }
      notifyTranscriptDisclosure();
    },
  };
}

// Fold toggles change block heights above the reader, and the scroll glue
// that follows the live edge reacts to exactly that. Subscribers (today only
// useSessionScroll's settle suspension) hear about every toggle through this
// registry: ledger.write is the choke point most fold controls go through,
// and controls that bypass it (review loops hold open state in component
// state) call notifyTranscriptDisclosure directly.
const disclosureListeners = new Set<() => void>();

export function onTranscriptDisclosure(listener: () => void): () => void {
  disclosureListeners.add(listener);
  return () => {
    disclosureListeners.delete(listener);
  };
}

export function notifyTranscriptDisclosure(): void {
  for (const listener of disclosureListeners) listener();
}

export const transcriptDisclosureLedger = createTranscriptDisclosureLedger();
