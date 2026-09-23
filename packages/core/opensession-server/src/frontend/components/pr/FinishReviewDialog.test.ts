import { expect, test } from "bun:test";

const panelSource = await Bun.file(
  new URL("../PrPanel.tsx", import.meta.url),
).text();
const dialogSource = await Bun.file(
  new URL("./FinishReviewDialog.tsx", import.meta.url),
).text();

test("PrPanel delegates finish-review state and focus behavior to its dialog", () => {
  expect(panelSource).toContain("<FinishReviewDialog");
  expect(panelSource).not.toContain("function FinishReviewDialog");
  expect(dialogSource).toContain("export function FinishReviewDialog");
  expect(dialogSource).toContain(
    "const [summary, setSummary] = useState(defaultSummary)",
  );
  expect(dialogSource).toContain(
    "onOpenChange={(next) => !next && onClose(summary)}",
  );
  expect(dialogSource).toContain("initialFocus={summaryRef}");
});

test("own-PR verdict restrictions drive both dialog choices and submission", () => {
  expect(panelSource).toContain(
    "const reviewEvent = allowedReviewEvent(selectedReviewEvent, canGiveVerdict)",
  );
  expect(panelSource).toContain("event: reviewEvent");
  expect(panelSource).toContain("canGiveVerdict={canGiveVerdict}");
  expect(dialogSource).toContain(
    'canGiveVerdict || verdict.event === "COMMENT"',
  );
});

test("merging requires confirmation and protects against target changes", () => {
  const merge = panelSource.slice(
    panelSource.indexOf("function handleMerge()"),
    panelSource.indexOf("function handleClose()"),
  );
  expect(merge.indexOf("confirmMerge({")).toBeLessThan(
    merge.indexOf("scheduleDeferredMerge("),
  );
  expect(merge).toContain('confirmLabel: "Squash and merge"');
  expect(merge).toContain(
    "if (actionTargetKey !== activeLoadTargetRef.current) return;",
  );
  expect(merge).toContain("cancelDeferredMergeByKey(mergeKey)");
  expect(panelSource).toContain("{mergeConfirmation}");
  expect(panelSource).toContain("mergeAction={phoneMergeAction}");
  expect(panelSource).toContain("{phoneMergeAction}");
});
