import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionContextMessage } from "./SessionContextMessage";

test("reserves the session context row before metadata arrives", () => {
  const html = renderToStaticMarkup(
    <SessionContextMessage sessionId="os-context-loading" />,
  );

  expect(html).toContain("data-session-context");
  expect(html).toContain('aria-label="Loading session context"');
  // The reservation is the h-3 utility (compat map, source spelling at test
  // time): one skeleton line that holds the row's height before metadata.
  expect(html).toContain("h-3");
});
