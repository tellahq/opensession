import { expect, test } from "bun:test";
import { auditCounts, findUnknownThemeTokens } from "./ui-audit";

/**
 * The ratchet. Each count may fall freely and never rise: a new raw `<button>`
 * or a new `text-[13px]` fails here rather than being noticed a year later on
 * a screen that reads subtly unlike the rest of the app.
 *
 * Failing this is not a request to edit the budget upward. Use the primitive
 * the message names, or — if the case genuinely needs something the system
 * does not have — add the variant to `src/frontend/ui/` and land it there.
 */
test("design-system drift stays under budget", () => {
  for (const { id, count, budget } of auditCounts()) {
    expect(
      count,
      `${id}: ${count} exceeds ${budget}. See bun scripts/ui-audit.ts --files ${id}`,
    ).toBeLessThanOrEqual(budget);
  }
});

test("unknown-theme-token catches hallucinated tokens and ignores valid utilities", () => {
  const bad = `
    <div className="rounded-panel border border-border/80 bg-canvas/50 text-title">
      <span className="border-border-subtle bg-muted text-muted-foreground" />
    </div>
  `;
  expect(findUnknownThemeTokens(bad)).toEqual([
    "border-border/80",
    "bg-canvas/50",
    "text-title",
    "border-border-subtle",
    "bg-muted",
    "text-muted-foreground",
  ]);

  const good = `
    // Comment mentioning border-border and bg-canvas should not count
    <div className="rounded-popup border-l-2 border-l-accent border-b-0 bg-panel/95 hover:bg-hover text-dialog-title text-fg ring-1 ring-line">
      <span className="border-divider bg-popup-glass text-dim smooth-shadow-ring-md" />
    </div>
  `;
  expect(findUnknownThemeTokens(good)).toEqual([]);
});

/*
 * There is deliberately no companion test asserting the budget EQUALS the
 * count. One existed for a few hours and was wrong for this repo: Open Session
 * develops itself out of a single shared checkout, so `src/frontend` almost
 * always holds another session's half-finished work, including its deletions.
 * A count that dips below the budget is usually somebody else mid-edit, not
 * progress waiting to be banked, and failing everyone's test run over it
 * teaches people to edit the budget file — the one thing this guard exists to
 * prevent.
 *
 * Banking progress stays a deliberate act: `bun scripts/ui-audit.ts --save`,
 * measured against HEAD in a detached worktree (the CLI refuses a dirty tree).
 */
