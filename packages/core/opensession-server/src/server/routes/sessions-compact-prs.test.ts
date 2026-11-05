import { describe, expect, test } from "bun:test";
import { restoreSharedPrs } from "../../frontend/lib/session-list-state";
import type { SessionListRow } from "./sessions";

const pr = (number: number) => ({
  repo: "acme",
  branch: `b-${number}`,
  source: "discovered" as const,
  number,
  state: "OPEN",
});

function row(
  id: string,
  workspaceId: string | undefined,
  prs?: ReturnType<typeof pr>[],
): SessionListRow {
  return { id, workspaceId, prs, title: id } as unknown as SessionListRow;
}

test("identical sibling PR lists travel once and restore exactly", async () => {
  const { compactSharedPrs } = await import("./sessions");
  const shared = [pr(1), pr(2)];
  const rows = [
    row("a", "ws-1", shared),
    row("b", "ws-1", structuredClone(shared)),
    row("c", "ws-1", [pr(1)]),
    row("d", "ws-2", structuredClone(shared)),
    row("e", undefined, structuredClone(shared)),
    row("f", "ws-1"),
  ];
  const original = structuredClone(rows);
  const compact = compactSharedPrs(rows);
  expect(compact.map((r) => r.prsFrom ?? null)).toEqual([
    null,
    "a",
    null,
    null,
    null,
    null,
  ]);
  expect("prs" in compact[1]).toBe(false);
  // The source rows themselves are not modified.
  expect(rows).toEqual(original);

  const restored = restoreSharedPrs(JSON.parse(JSON.stringify(compact)));
  expect(restored).toEqual(JSON.parse(JSON.stringify(original)));
  // Restored lists are independent copies.
  restored[1].prs![0].number = 99;
  expect(restored[0].prs![0].number).toBe(1);
});

describe("stringifyRowsYielding", () => {
  test("produces exactly JSON.stringify's text across chunk boundaries", async () => {
    const { stringifyRowsYielding } = await import("./sessions");
    for (const count of [0, 1, 499, 500, 501, 1234]) {
      const rows = Array.from({ length: count }, (_, index) => ({
        id: `s-${index}`,
        title: index % 7 === 0 ? 'quote " and   line' : `t${index}`,
        prs: index % 3 === 0 ? [] : [{ number: index, url: undefined }],
        nested: { ok: index % 2 === 0, none: null },
      }));
      expect(await stringifyRowsYielding(rows)).toBe(JSON.stringify(rows));
    }
  });
});
