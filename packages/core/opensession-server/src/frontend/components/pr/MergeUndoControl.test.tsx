import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MergeUndoControl } from "./MergeUndoControl";

test("renders one undo button with the seconds left", () => {
  const html = renderToStaticMarkup(
    <MergeUndoControl onUndo={() => undefined} deadline={Date.now() + 4900} />,
  );
  expect(html).toContain('aria-label="Undo merge, 5s left"');
  expect(html).toContain(">5</span>");
  expect(html).not.toContain("PR merged");
  expect(html.match(/<button/g)).toHaveLength(1);
});

test("shows a bare glyph without a deadline", () => {
  const html = renderToStaticMarkup(
    <MergeUndoControl onUndo={() => undefined} />,
  );
  expect(html).toContain('aria-label="Undo merge"');
  expect(html).not.toContain("tabular-nums");
});
