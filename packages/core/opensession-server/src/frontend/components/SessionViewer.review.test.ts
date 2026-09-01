import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("./SessionViewer.tsx", import.meta.url),
).text();

test("session Review keeps PR navigation below workspace actions", () => {
  expect(source).toContain(
    'const [reviewPage, setReviewPage] = useState<PrReviewPage>("files")',
  );

  const summaryStart = source.indexOf("<WorkspaceSummary");
  const summaryEnd = source.indexOf("/>", summaryStart);
  const summary = source.slice(summaryStart, summaryEnd);
  expect(summaryStart).toBeGreaterThan(-1);
  expect(summary).toContain("reviewMode={showReview}");
  expect(summary).not.toContain("reviewPage={reviewPage}");
  expect(summary).not.toContain("onReviewPageChange={setReviewPage}");

  const panelStart = source.lastIndexOf("<PrPanel");
  const panelEnd = source.indexOf("/>", panelStart);
  const panel = source.slice(panelStart, panelEnd);
  expect(panelStart).toBeGreaterThan(-1);
  expect(panel).toContain("page={reviewPage}");
  expect(panel).toContain("onPageChange={setReviewPage}");
  expect(panel).toContain("compactToolbar={summaryVisible}");
  expect(panel).toContain("sessionActionTarget={");
  expect(source).toContain("menuTrailing={");
  expect(source).toContain("ref={setReviewSessionActionTarget}");
});
