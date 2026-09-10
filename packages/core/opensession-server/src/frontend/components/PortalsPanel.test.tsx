import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewStatus } from "../lib/api";
import { PortalsPage } from "./PortalsPanel";

const status: PreviewStatus = {
  services: [
    {
      name: "Simulator",
      key: "simulator",
      port: 8080,
      running: true,
      pids: [42],
      previewUrl: "https://portal.example.test/simulator",
    },
  ],
};

const noop = () => {};

test("a running portal can be pinned beside the conversation", () => {
  const html = renderToStaticMarkup(
    <PortalsPage
      sessionId="session-1"
      status={status}
      onBack={noop}
      onOpenPortal={noop}
      onPinPortal={noop}
    />,
  );

  expect(html).toContain('aria-label="Pin Simulator beside the conversation"');
  expect(html).toContain('title="Pin beside conversation"');
});

test("the pin action is omitted when the host does not support a side panel", () => {
  const html = renderToStaticMarkup(
    <PortalsPage
      sessionId="session-1"
      status={status}
      onBack={noop}
      onOpenPortal={noop}
    />,
  );

  expect(html).not.toContain("Pin Simulator beside the conversation");
});
