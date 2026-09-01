import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { UnifiedSession } from "../../server/types";
import {
  claimShippedChangeAnnouncement,
  selectShippedVisualChange,
  settleShippedChangeAnnouncement,
  shippedChangeAnnouncementKey,
  shippedChangeOneLiner,
  normalizeShippedChangeMessage,
  validWalkthroughScreenshot,
  validFeaturedScreenshot,
} from "./shipped-change-notify";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function session(
  id: string,
  publishedAt: string,
  shots: Array<{ before?: string; after?: string }>,
): UnifiedSession {
  return {
    id,
    branch: "visual-branch",
    walkthrough: { summary: `Why ${id} matters.`, publishedAt, shots },
  } as UnifiedSession;
}

describe("shipped visual change selection", () => {
  test("uses the session's after screenshot", () => {
    const visual = session("preferred", "2026-08-10T10:00:00Z", [
      { before: "/tmp/before.png", after: "/tmp/preferred.png" },
    ]);

    expect(selectShippedVisualChange(visual, () => true)).toEqual({
      sessionId: "preferred",
      screenshots: ["/tmp/preferred.png"],
      summary: "Why preferred matters.",
    });
  });

  test("requires a valid after screenshot", () => {
    const textOnly = session("text-only", "2026-08-12T10:00:00Z", [
      { before: "/tmp/before.png" },
    ]);
    const missing = session("missing", "2026-08-11T10:00:00Z", [
      { after: "/tmp/missing.png" },
    ]);

    expect(selectShippedVisualChange(textOnly, () => true)).toBeNull();
    expect(selectShippedVisualChange(missing, () => false)).toBeNull();
  });

  test("falls back to a featured transcript screenshot", () => {
    const root = mkdtempSync(join(tmpdir(), "shipped-featured-selection-"));
    scratch.push(root);
    const image = join(root, "after.png");
    writeFileSync(image, "png");

    expect(
      selectShippedVisualChange(
        session("featured", "2026-08-12T10:00:00Z", []),
        () => false,
        [image],
      ),
    ).toEqual({
      sessionId: "featured",
      screenshots: [image],
      summary: "Why featured matters.",
    });
  });

  test("keeps an explicitly empty attachment list empty", () => {
    const visual = session("removed", "2026-08-12T10:00:00Z", [
      { after: "/tmp/removed.png" },
    ]);

    expect(selectShippedVisualChange(visual, () => true, [])).toBeNull();
  });

  test("accepts only bounded images inside the session walkthrough directory", () => {
    const root = mkdtempSync(join(tmpdir(), "shipped-change-assets-"));
    scratch.push(root);
    const sessionDir = join(root, "walkthrough", "safe-session");
    mkdirSync(sessionDir, { recursive: true });
    const inside = join(sessionDir, "after.png");
    const outside = join(root, "outside.png");
    writeFileSync(inside, "png");
    writeFileSync(outside, "png");

    expect(validWalkthroughScreenshot(inside, "safe-session", root)).toBe(true);
    expect(validWalkthroughScreenshot(outside, "safe-session", root)).toBe(
      false,
    );
  });

  test("accepts bounded featured screenshots from temporary storage", () => {
    const root = mkdtempSync(join(tmpdir(), "shipped-featured-"));
    scratch.push(root);
    const image = join(root, "after.png");
    writeFileSync(image, "png");
    expect(validFeaturedScreenshot(image)).toBe(true);
  });
});

describe("shipped change copy", () => {
  test("accepts an editable short message", () => {
    expect(
      normalizeShippedChangeMessage(
        "  We updated the toggle style in Tella.  ",
      ),
    ).toBe("We updated the toggle style in Tella.");
    expect(() => normalizeShippedChangeMessage("x".repeat(501))).toThrow(
      "500 characters or fewer",
    );
  });

  test("uses the first prose paragraph and strips markdown", () => {
    expect(
      shippedChangeOneLiner(
        "## What changed\n\n**Tabs** now stay visible through [navigation](https://example.com).\nThey are easier to find.\n\nVerified on mobile.",
      ),
    ).toBe(
      "Tabs now stay visible through navigation. They are easier to find.",
    );
  });

  test("truncates long copy on a word boundary", () => {
    const result = shippedChangeOneLiner(
      "A visual improvement that makes the editor easier to scan.",
      34,
    );
    expect(result).toBe("A visual improvement that makes…");
    expect(result.length).toBeLessThanOrEqual(34);
  });

  test("does not announce without a prose explanation", () => {
    expect(shippedChangeOneLiner("## Screenshot only")).toBe("");
  });
});

describe("shipped change announcement receipts", () => {
  test("deduplicates identical posts but permits a changed attachment set", () => {
    const original = shippedChangeAnnouncementKey(
      "tellahq/example",
      12,
      "C1",
      "Shipped",
      ["a.png"],
    );
    expect(
      shippedChangeAnnouncementKey("tellahq/example", 12, "C1", "Shipped", [
        "a.png",
      ]),
    ).toBe(original);
    expect(
      shippedChangeAnnouncementKey("tellahq/example", 12, "C1", "Shipped", [
        "a.png",
        "b.png",
      ]),
    ).not.toBe(original);
  });

  test("deduplicates a sent merge and releases failed claims", () => {
    const root = mkdtempSync(join(tmpdir(), "shipped-change-state-"));
    scratch.push(root);
    const statePath = join(root, "state.json");
    const key = "tellahq/example#12@abc";
    const claim = claimShippedChangeAnnouncement(key, statePath, 1_000);
    expect(claim).toBeString();
    expect(claimShippedChangeAnnouncement(key, statePath, 1_001)).toBeNull();
    settleShippedChangeAnnouncement(key, claim!, true, "session-1", statePath);
    expect(claimShippedChangeAnnouncement(key, statePath, 2_000)).toBeNull();

    const retryKey = "tellahq/example#13@def";
    const failed = claimShippedChangeAnnouncement(retryKey, statePath, 3_000)!;
    settleShippedChangeAnnouncement(
      retryKey,
      failed,
      false,
      undefined,
      statePath,
    );
    expect(
      claimShippedChangeAnnouncement(retryKey, statePath, 3_001),
    ).toBeString();
  });
});
