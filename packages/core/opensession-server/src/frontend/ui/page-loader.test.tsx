import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageLoader } from "./page-loader";

test("page loading uses the larger round spinner", () => {
  const html = renderToStaticMarkup(<PageLoader className="text-dim" />);
  expect(html).toContain("spinner__styles.ring");
  expect(html).toContain("spinner__styles.lg");
  expect(html).toContain("text-dim");
  expect(html.match(/<span/g)).toHaveLength(1);
});
