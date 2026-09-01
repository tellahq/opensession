import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { providerFromUrl } from "../../lib/provider";
import { ConversationView } from "./PrViews";

const comments = [
  {
    author: "michielw",
    body: "Looks good.",
    createdAt: "2026-08-29T10:00:00.000Z",
  },
];

test("pull request conversations show GitHub profile images", () => {
  const html = renderToStaticMarkup(
    <ConversationView
      author="kentdebruin"
      descriptionHtml="<p>Summary</p>"
      comments={comments}
      provider={providerFromUrl(
        "https://github.com/tellahq/opensession/pull/1",
      )}
    />,
  );

  expect(html).toContain("https://github.com/kentdebruin.png?size=56");
  expect(html).toContain("https://github.com/michielw.png?size=56");
});

test("providers without profile images retain initial avatars", () => {
  const html = renderToStaticMarkup(
    <ConversationView
      author="kentdebruin"
      descriptionHtml="<p>Summary</p>"
      comments={comments}
      provider={providerFromUrl("https://team.code.storage/review/1")}
    />,
  );

  expect(html).not.toContain("<img");
  expect(html).toContain(">K</span>");
  expect(html).toContain(">M</span>");
});
