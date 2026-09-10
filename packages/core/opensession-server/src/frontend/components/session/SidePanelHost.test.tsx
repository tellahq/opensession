import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidePanelHost } from "./SidePanelHost";

const noop = () => {};

test("pinned content replaces the side-panel tabs and page", () => {
  const html = renderToStaticMarkup(
    <SidePanelHost
      hidden={false}
      isPhone={false}
      available
      open
      onOpenChange={noop}
      resizeHandle={null}
      hasWorkspace
      page="portals"
      onPageChange={noop}
      livePortals={1}
      runningAgents={0}
      terminalMounted={false}
      onTerminalMount={noop}
      sessionId="session-1"
      pinned={
        <iframe title="Pinned portal" src="https://portal.example.test" />
      }
      changes={<div>Changes page</div>}
      portals={<div>Portals page</div>}
      agents={<div>Agents page</div>}
    />,
  );

  expect(html).toContain('title="Pinned portal"');
  expect(html).not.toContain("Portals page");
  expect(html).not.toContain("Changes page");
  expect(html).not.toContain("Terminal");
});
