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

test("description previews retain complete markdown and links", () => {
  const body = `<p>${"A detailed summary. ".repeat(100)}</p><p><a href="https://example.test/details">Details</a></p>`;
  const html = renderToStaticMarkup(
    <ConversationView
      author="acme"
      descriptionHtml={body}
      comments={[]}
      provider={providerFromUrl("https://github.com/acme/project/pull/1")}
    />,
  );

  expect(html).toContain(body);
  expect(html).toContain("phone:max-h-80 phone:overflow-hidden");
  expect(html).not.toContain("line-clamp");
});

test("empty descriptions keep their explicit empty state", () => {
  const html = renderToStaticMarkup(
    <ConversationView
      author="acme"
      descriptionHtml=""
      comments={[]}
      provider={providerFromUrl("https://github.com/acme/project/pull/1")}
    />,
  );

  expect(html).toContain("This pull request has no description.");
  expect(html).not.toContain("Read more");
});
