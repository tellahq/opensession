import { describe, expect, spyOn, test } from "bun:test";
import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import {
  buildTranscriptRanges,
  mergeTranscriptIndexEntries,
  transcriptIndexEntryFromPayload,
} from "./transcript-index";

const row = (
  seq: number,
  role: TranscriptIndexEntry["role"],
  extra: Partial<TranscriptIndexEntry> = {},
): TranscriptIndexEntry => ({
  id: `e${seq}`,
  seq,
  changeSeq: seq,
  timestampMs: seq * 1000,
  role,
  contentLength: 20,
  ...extra,
});

describe("buildTranscriptRanges", () => {
  test("builds stable user turns across unloaded tool rows", () => {
    const ranges = buildTranscriptRanges([
      row(1, "user"),
      row(2, "assistant"),
      row(3, "tool_use"),
      row(4, "tool_result"),
      row(5, "assistant"),
      row(6, "user"),
    ]);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({
      firstSeq: 1,
      lastSeq: 5,
      headRole: "user",
      entryIds: ["e1", "e2", "e3", "e4", "e5"],
    });
    expect(ranges[1]).toMatchObject({ firstSeq: 6, lastSeq: 6 });
  });

  test("keeps a compaction notice inside the work around it", () => {
    const ranges = buildTranscriptRanges([
      row(1, "user"),
      row(2, "tool_use"),
      row(3, "notice", { noticeKind: "compaction" }),
      row(4, "tool_use"),
      row(5, "assistant"),
      row(6, "notice"),
    ]);
    expect(ranges.map((range) => range.entryIds)).toEqual([
      ["e1", "e2", "e3", "e4", "e5"],
      ["e6"],
    ]);
  });

  test("marks a compaction notice derived from a live payload", () => {
    expect(
      transcriptIndexEntryFromPayload({
        id: "c",
        type: "system",
        content: "summary",
        timestamp: "2026-11-17T10:00:00Z",
        seq: 3,
        changeSeq: 3,
        noticeKind: "compaction",
        notice: { kind: "compaction", title: "Context compacted" },
      }),
    ).toMatchObject({ role: "notice", noticeKind: "compaction" });
  });

  test("keeps hidden seqs in fetch coverage without rendering an item", () => {
    const ranges = buildTranscriptRanges([
      row(1, "hidden"),
      row(2, "user"),
      row(3, "hidden"),
      row(4, "assistant"),
    ]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ firstSeq: 2, lastSeq: 4 });
    expect(ranges[0].entryIds).toEqual(["e2", "e4"]);
  });

  test("retains review metadata for client-side loop grouping", () => {
    const [range] = buildTranscriptRanges([
      row(1, "review_handoff", { reviewPrNumber: 42 }),
      row(2, "assistant"),
    ]);
    expect(range).toMatchObject({
      headRole: "review_handoff",
      reviewPrNumber: 42,
      reviewRounds: 1,
    });
  });

  test("a check-back starts its own range for client-side folding", () => {
    const ranges = buildTranscriptRanges([
      row(1, "user"),
      row(2, "assistant"),
      row(3, "check_back", { contentLength: 0 }),
      row(4, "tool_use"),
      row(5, "assistant"),
    ]);
    expect(ranges.map((range) => range.headRole)).toEqual([
      "user",
      "check_back",
    ]);
  });

  test("live appends index wait boundaries and scheduled check-backs", () => {
    const base = {
      id: "x",
      content: "",
      timestamp: "2026-10-08T10:00:00Z",
      seq: 1,
      changeSeq: 1,
    };
    expect(
      transcriptIndexEntryFromPayload({
        ...base,
        type: "user",
        turnBoundary: true,
      })?.role,
    ).toBe("check_back");
    expect(
      transcriptIndexEntryFromPayload({
        ...base,
        type: "user",
        notice: { kind: "scheduled-prompt", title: "Scheduled check-back" },
      })?.role,
    ).toBe("check_back");
    expect(
      transcriptIndexEntryFromPayload({ ...base, type: "user" })?.role,
    ).toBe("user");
  });
});

/** The complete keyed merge, as the sole implementation used to read. Every
 * frame shape must produce exactly this outline, whichever path handles it. */
function referenceMerge(
  current: TranscriptIndexEntry[],
  incoming: TranscriptIndexEntry[],
): TranscriptIndexEntry[] {
  if (!incoming.length) return current;
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  let changed = false;
  for (const entry of incoming) {
    const previous = bySeq.get(entry.seq);
    if (
      !previous ||
      entry.changeSeq > previous.changeSeq ||
      (entry.changeSeq === previous.changeSeq &&
        previous.role === "notice" &&
        entry.role === "agent_message")
    ) {
      bySeq.set(entry.seq, entry);
      changed = true;
    }
  }
  return changed ? [...bySeq.values()].sort((a, b) => a.seq - b.seq) : current;
}

const ROLES: TranscriptIndexEntry["role"][] = [
  "agent_message",
  "user",
  "assistant",
  "tool_use",
  "tool_result",
  "hidden",
  "notice",
];

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** Freeze a fixture so any in-place mutation by the merge throws. The merge
 * accepts the mutable protocol array type its callers store in state. */
function frozen(rows: TranscriptIndexEntry[]): TranscriptIndexEntry[] {
  // SAFETY: the merge never writes to its inputs (that is the property under
  // test), so a frozen array is used exactly like a mutable one.
  return Object.freeze(rows) as TranscriptIndexEntry[];
}

/** An immutable outline of `length` seq-sorted rows starting at `firstSeq`. */
function outline(firstSeq: number, length: number): TranscriptIndexEntry[] {
  return frozen(
    Array.from({ length }, (_, index) =>
      row(firstSeq + index, ROLES[index % ROLES.length]!),
    ),
  );
}

describe("mergeTranscriptIndexEntries", () => {
  test("keeps newer changeSeq data when frames arrive out of order", () => {
    const newer = row(1, "user", { changeSeq: 4 });
    expect(
      mergeTranscriptIndexEntries(
        [newer],
        [row(1, "assistant", { changeSeq: 3 })],
      ),
    ).toEqual([newer]);
  });

  test("appends a strictly increasing new tail as a fresh sorted outline", () => {
    const current = outline(1, 4);
    const incoming = frozen([row(5, "assistant"), row(6, "tool_use")]);
    const merged = mergeTranscriptIndexEntries(current, incoming);
    expect(merged).toEqual(referenceMerge(current, incoming));
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(merged).not.toBe(current);
    expect(current).toHaveLength(4);
    // A seq-sorted frame onto an empty outline is a new tail too.
    expect(mergeTranscriptIndexEntries([], incoming)).toEqual(
      referenceMerge([], incoming),
    );
  });

  test("appends hidden tail rows the same way as visible ones", () => {
    const current = outline(1, 3);
    const incoming = [row(4, "hidden"), row(5, "hidden"), row(6, "user")];
    const merged = mergeTranscriptIndexEntries(current, incoming);
    expect(merged).toEqual(referenceMerge(current, incoming));
    expect(merged.slice(3)).toEqual(incoming);
  });

  test("equal and stale tail rows keep the current outline identity", () => {
    const current = outline(1, 3);
    expect(mergeTranscriptIndexEntries(current, [])).toBe(current);
    expect(mergeTranscriptIndexEntries(current, [row(3, "tool_use")])).toBe(
      current,
    );
    expect(
      mergeTranscriptIndexEntries(current, [
        row(3, "tool_use", { changeSeq: 1 }),
      ]),
    ).toBe(current);
    expect(
      mergeTranscriptIndexEntries(current, [
        row(2, "user", { changeSeq: 0 }),
        row(3, "user", { changeSeq: 0 }),
      ]),
    ).toBe(current);
  });

  test("a duplicated seq inside one frame takes the keyed merge", () => {
    const current = outline(1, 2);
    const incoming = [
      row(3, "assistant", { changeSeq: 3 }),
      row(3, "assistant", { changeSeq: 9, contentLength: 400 }),
      row(4, "user"),
    ];
    const merged = mergeTranscriptIndexEntries(current, incoming);
    expect(merged).toEqual(referenceMerge(current, incoming));
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(merged[2]?.changeSeq).toBe(9);
  });

  test("an unsorted new tail is merged and sorted", () => {
    const current = outline(1, 3);
    const incoming = [row(6, "user"), row(4, "assistant"), row(5, "tool_use")];
    const merged = mergeTranscriptIndexEntries(current, incoming);
    expect(merged).toEqual(referenceMerge(current, incoming));
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a historical replacement rewrites in place and leaves the snapshot alone", () => {
    const current = outline(1, 5);
    // Same role, longer prompt: the metadata change alone moves the estimate.
    const replacement = row(1, "user", {
      changeSeq: 40,
      contentLength: 2_000,
    });
    const merged = mergeTranscriptIndexEntries(current, [
      replacement,
      row(6, "user"),
    ]);
    expect(merged).toEqual(
      referenceMerge(current, [replacement, row(6, "user")]),
    );
    expect(merged[0]).toBe(replacement);
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(current[0]?.contentLength).toBe(20);
    expect(buildTranscriptRanges(merged)[0]?.estimateSize).not.toBe(
      buildTranscriptRanges(current)[0]?.estimateSize,
    );
  });

  test("a large tail append builds no seq map and never sorts", () => {
    const readsBySeq = new Map<number, number>();
    const current = outline(1, 5_000).map(
      (entry) =>
        new Proxy(entry, {
          get(target, property) {
            readsBySeq.set(target.seq, (readsBySeq.get(target.seq) ?? 0) + 1);
            // SAFETY: the proxy forwards whichever field the merge reads from
            // the same row; the fixture only declares protocol fields.
            return target[property as keyof TranscriptIndexEntry];
          },
        }),
    );
    const incoming = [row(5_001, "assistant"), row(5_002, "tool_use")];
    const sort = spyOn(Array.prototype, "sort");
    try {
      const merged = mergeTranscriptIndexEntries(current, incoming);
      expect(merged).toHaveLength(5_002);
      expect(merged[5_001]).toBe(incoming[1]!);
      expect(sort).not.toHaveBeenCalled();
    } finally {
      sort.mockRestore();
    }
    // Only the tail row is consulted; a keyed merge would read every row.
    expect([...readsBySeq.keys()]).toEqual([5_000]);
    expect(readsBySeq.get(5_000)).toBe(1);
  });

  test("matches the complete keyed merge for every random frame", () => {
    const random = seededRandom(42);
    const pick = <T>(values: readonly T[]) =>
      values[Math.floor(random() * values.length)]!;
    for (let round = 0; round < 400; round++) {
      const length = Math.floor(random() * 12);
      const current = outline(1, length).map((entry) =>
        Object.freeze({
          ...entry,
          changeSeq: entry.seq + Math.floor(random() * 3),
        }),
      );
      const frameSize = Math.floor(random() * 5);
      const incoming: TranscriptIndexEntry[] = [];
      let nextTailSeq = length + 1;
      for (let index = 0; index < frameSize; index++) {
        const rowKind = pick(["tail", "tail", "tail", "stale", "newer", "dup"]);
        if (rowKind === "tail" || !length) {
          incoming.push(
            row(nextTailSeq++, pick(ROLES), {
              changeSeq: nextTailSeq + Math.floor(random() * 3),
            }),
          );
        } else if (rowKind === "dup" && incoming.length) {
          const twin = incoming[incoming.length - 1]!;
          incoming.push({
            ...twin,
            changeSeq: twin.changeSeq + Math.floor(random() * 3) - 1,
            contentLength: 99,
          });
        } else {
          const target = current[Math.floor(random() * length)]!;
          incoming.push(
            row(target.seq, pick(ROLES), {
              changeSeq:
                rowKind === "newer"
                  ? target.changeSeq + 1
                  : target.changeSeq - Math.floor(random() * 2),
              contentLength: 300,
            }),
          );
        }
      }
      if (random() < 0.25) incoming.reverse();
      const frozenCurrent = frozen([...current]);
      const frozenIncoming = frozen([...incoming]);
      const expected = referenceMerge(frozenCurrent, frozenIncoming);
      const merged = mergeTranscriptIndexEntries(frozenCurrent, frozenIncoming);
      expect(merged).toEqual(expected);
      if (expected === frozenCurrent) expect(merged).toBe(frozenCurrent);
      else expect(merged).not.toBe(frozenCurrent);
    }
  });
});

test("agent correspondence does not split indexed work ranges", () => {
  const ranges = buildTranscriptRanges([
    row(1, "user"),
    row(2, "tool_use"),
    row(3, "agent_message"),
    row(4, "tool_use"),
    row(5, "assistant"),
    row(6, "user"),
  ]);
  expect(ranges).toHaveLength(2);
  expect(ranges[0]!.entryIds).toHaveLength(5);
});

test("legacy notice projections upgrade without inventing a transcript change", () => {
  const legacy = row(2, "notice", { changeSeq: 3 });
  const current = row(2, "agent_message", { changeSeq: 3 });
  expect(mergeTranscriptIndexEntries([legacy], [current])).toEqual([current]);
  expect(mergeTranscriptIndexEntries([current], [legacy])).toEqual([current]);
});
