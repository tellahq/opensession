import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PhoneReviewHeader } from "./PhoneReviewHeader";

test("phone review has one heading, navigation and action slots", () => {
  const html = renderToStaticMarkup(
    <PhoneReviewHeader
      title="Files changed"
      subtitle={<span>+24 −8</span>}
      navigation={<button>Back to overview</button>}
      actions={<button>Code view settings</button>}
    />,
  );
  expect(html.match(/<h1/g)).toHaveLength(1);
  expect(html).toContain("Files changed");
  expect(html).toContain("+24 −8");
  expect(html).toContain("Back to overview");
  expect(html).toContain("Code view settings");
  expect(html).not.toContain("Finish review");
});
