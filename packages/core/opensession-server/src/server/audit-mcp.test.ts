import { describe, expect, it } from "bun:test";
import { type AuditDigestDeps, auditDigestPayload } from "./audit-mcp";

/** A digest stub with the fields the payload caps or reports on. `build`
 *  records what it was asked for, so a rejected date can be shown never to
 *  reach the filename. */
function deps(
  digest: Record<string, unknown> | null,
  asked: string[] = [],
): AuditDigestDeps & { asked: string[] } {
  return {
    asked,
    build: (date: string) => {
      asked.push(date);
      return digest ? structuredClone(digest) : null;
    },
    dates: () => ["2026-08-18", "2026-08-17"],
  };
}

const DIGEST = {
  date: "2026-08-18",
  totals: { events: 12, sessions: 2, turns: 3, errors: 1 },
  papercuts: [{ text: "one" }],
  sessions: [{ id: "os-1", turns: 3 }],
};

describe("auditDigestPayload", () => {
  it("returns the digest for a valid date", () => {
    const d = deps(DIGEST);
    const out = auditDigestPayload("2026-08-18", d);
    expect(d.asked).toEqual(["2026-08-18"]);
    expect(out.ok).toBe(true);
    expect(out.totals).toEqual(DIGEST.totals);
    expect(out.papercuts).toEqual(DIGEST.papercuts);
    expect(out.truncated).toBeUndefined();
  });

  it("defaults to yesterday (UTC) when no date is given", () => {
    const d = deps(DIGEST);
    auditDigestPayload(undefined, d);
    expect(d.asked).toEqual([
      new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    ]);
  });

  it("rejects malformed dates without reaching the log", () => {
    for (const bad of [
      "../../etc/passwd",
      "2026-08-18/../secret",
      "2026-8-1",
      "2026-08-18.jsonl",
      "*",
      "2026-08-18..2026-08-19",
      "2026-08-18 2026-08-19",
      "yesterday",
    ]) {
      const d = deps(DIGEST);
      const out = auditDigestPayload(bad, d);
      expect(out.ok).toBe(false);
      expect(String(out.error)).toContain("YYYY-MM-DD");
      // The rejected value must never have become a filename.
      expect(d.asked).toEqual([]);
    }
  });

  it("treats a blank date as an omitted one", () => {
    const d = deps(DIGEST);
    expect(auditDigestPayload("  ", d).ok).toBe(true);
    expect(d.asked).toEqual([
      new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    ]);
  });

  it("says so, with the days it does have, when there is no log", () => {
    const out = auditDigestPayload("2020-01-01", deps(null));
    expect(out.ok).toBe(false);
    expect(out.date).toBe("2020-01-01");
    expect(String(out.error)).toContain("no audit log for 2020-01-01");
    expect(out.availableDates).toEqual(["2026-08-18", "2026-08-17"]);
  });

  it("caps the lists that grow with the day and says what it dropped", () => {
    const big = {
      ...DIGEST,
      papercuts: Array.from({ length: 90 }, (_, i) => ({ text: `p${i}` })),
      sessions: Array.from({ length: 60 }, (_, i) => ({ id: `os-${i}` })),
    };
    const out = auditDigestPayload("2026-08-18", deps(big));
    expect(out.ok).toBe(true);
    expect((out.papercuts as unknown[]).length).toBe(40);
    expect((out.sessions as unknown[]).length).toBe(40);
    expect(out.truncated).toEqual({
      papercuts: { kept: 40, dropped: 50 },
      sessions: { kept: 40, dropped: 20 },
    });
    expect(String(out.truncatedNote)).toContain("Totals");
  });

  it("drops detail sections when the capped digest is still outsized", () => {
    const huge = {
      ...DIGEST,
      sessions: Array.from({ length: 40 }, (_, i) => ({
        id: `os-${i}`,
        firstPrompt: "x".repeat(4000),
      })),
    };
    const out = auditDigestPayload("2026-08-18", deps(huge));
    expect(JSON.stringify(out).length).toBeLessThan(120_000);
    expect(out.sessions).toEqual([]);
    expect(
      (out.truncated as Record<string, { kept: number }>).sessions.kept,
    ).toBe(0);
    // Totals survive whatever gets dropped.
    expect(out.totals).toEqual(DIGEST.totals);
  });
});
