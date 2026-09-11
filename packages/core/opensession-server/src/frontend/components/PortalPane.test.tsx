import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PortalTarget } from "../lib/portals";
import { PortalPane } from "./PortalPane";

const target: PortalTarget = {
  sessionId: "session-1",
  name: "Simulator",
  key: "simulator",
  port: 8080,
  url: "https://portal.example.test/simulator",
};

const noop = () => {};

test("a pinned portal has close and full-width actions around its iframe", () => {
  const html = renderToStaticMarkup(
    <PortalPane target={target} onClose={noop} onExpand={noop} />,
  );

  expect(html).toContain(`src="${target.url}"`);
  expect(html).toContain('aria-label="Expand Simulator to full width"');
  expect(html).toContain('aria-label="Close Simulator side panel"');
  expect(html).toContain('title="Simulator portal"');
});

test("a full-width portal does not show side-panel actions", () => {
  const html = renderToStaticMarkup(<PortalPane target={target} />);

  expect(html).not.toContain("Expand Simulator to full width");
  expect(html).not.toContain("Close Simulator side panel");
});
