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
