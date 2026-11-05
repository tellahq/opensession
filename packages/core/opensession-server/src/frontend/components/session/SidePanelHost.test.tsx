import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SidePanelPage, SidePanelTab } from "../../lib/side-panel-open";
import { SidePanelHost } from "./SidePanelHost";

const noop = () => {};

function render(
  page: SidePanelPage,
  tabs: SidePanelTab[],
  availableTabs: SidePanelTab[] = tabs,
) {
  return renderToStaticMarkup(
    <SidePanelHost
      hidden={false}
      isPhone={false}
      available
      open
      onOpenChange={noop}
      resizeHandle={null}
      hasWorkspace
      page={page}
      onPageChange={noop}
      tabs={tabs}
      availableTabs={availableTabs}
      onCloseTab={noop}
      onMoveToMain={noop}
      browserLabel="ios-simulator"
      livePortals={1}
      runningAgents={0}
      terminalMounted={false}
      onTerminalMount={noop}
      sessionId="session-1"
      changes={<div>Changes page</div>}
      review={<div>Review page</div>}
      browser={
        <iframe title="Pinned portal" src="https://portal.example.test" />
      }
      portals={<div>Portals page</div>}
      agents={<div>Agents page</div>}
    />,
  );
}

test("the panel shows its open tabs and the selected page", () => {
  const html = render("browser", ["changes", "browser"]);
  expect(html).toContain('title="Pinned portal"');
  expect(html).toContain("ios-simulator");
  expect(html).toContain("Changes");
  expect(html).not.toContain("Changes page");
  expect(html).not.toContain("Portals");
  expect(html).toContain('aria-label="Move to main tabs"');
});

test("a tab the session cannot show stays out and its page falls back", () => {
  const html = render("review", ["changes", "review"], ["changes"]);
  expect(html).not.toContain("Review page");
  expect(html).toContain("Changes page");
  expect(html).not.toContain('aria-label="Move to main tabs"');
});

test("the new-tab page lists what the panel can open", () => {
  const html = render("new", [], ["changes", "review", "terminal"]);
  expect(html).toContain("New tab");
  expect(html).toContain("Review");
  expect(html).toContain("Terminal");
  expect(html).not.toContain("Changes page");
});
