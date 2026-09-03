import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionContextMessage } from "./SessionContextMessage";

test("reserves the session context row before metadata arrives", () => {
  const html = renderToStaticMarkup(
    <SessionContextMessage sessionId="os-context-loading" />,
  );

  expect(html).toContain("data-session-context");
  expect(html).toContain('aria-label="Loading session context"');
  expect(html).toContain("h-5 w-44");
});

test("reports transcript loading inside the session context slot", () => {
  const html = renderToStaticMarkup(
    <SessionContextMessage sessionId="os-context-loading" historyLoading />,
  );

  expect(html).toContain("data-session-context");
  expect(html).toContain("data-transcript-loading");
  expect(html).toContain("Loading transcript…");
  expect(html).toContain("animate-spin");
  expect(html).toContain("h-5");
  expect(html).not.toContain("Loading session context");
});
