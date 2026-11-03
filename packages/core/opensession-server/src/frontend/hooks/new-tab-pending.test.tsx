import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPaneProviders } from "../components/SessionPaneProviders";
import type { SessionSocket } from "./useSessionSocket";
import { useSessionPendingCreation } from "./useSessionPendingCreation";

const source = (path: string) =>
  Bun.file(new URL(path, import.meta.url)).text();

const socket: SessionSocket = {
  send: () => {},
  addHandler: () => () => {},
};

function PendingProbe() {
  return <span>{String(useSessionPendingCreation())}</span>;
}

test("a new tab routes in the same commit that marks it pending", async () => {
  // App drops a pending id the route has left. Committing the pending id
  // while the previous session is still routed clears it at once, so the new
  // pane mounts connected, watches an id the server does not know yet, and
  // shows "Session not found" until the create lands.
  const tabs = await source("./useSessionTabs.tsx");
  const create = tabs.slice(
    tabs.indexOf("async function createNewSessionFrom("),
    tabs.indexOf("return await (async () => {"),
  );
  const commit = create.slice(
    create.indexOf("flushSync(() => {"),
    create.indexOf("\n    });", create.indexOf("flushSync(() => {")),
  );
  expect(commit).toContain("setPendingSessionId(id);");
  expect(commit).toContain('navigate({ view: "session", id });');
  expect(create.match(/navigate\(/g)).toHaveLength(1);
});

test("the pane tells its surfaces whether the session is still local", async () => {
  expect(
    renderToStaticMarkup(
      <SessionPaneProviders repo={undefined} socket={socket} pendingCreation>
        <PendingProbe />
      </SessionPaneProviders>,
    ),
  ).toBe("<span>true</span>");
  expect(
    renderToStaticMarkup(
      <SessionPaneProviders repo={undefined} socket={socket}>
        <PendingProbe />
      </SessionPaneProviders>,
    ),
  ).toBe("<span>false</span>");
  expect(renderToStaticMarkup(<PendingProbe />)).toBe("<span>false</span>");

  const pane = await source("../components/AppSessionPane.tsx");
  expect(pane).toContain("pendingCreation={pendingSocket}");
});

test("PR and git reads wait until a new tab's create lands", async () => {
  // Their 404 for a local id sits in the shared SWR cache, and the PR card
  // shows it as "Session not found" until the next fetch.
  for (const path of [
    "../components/PrStatusBar.tsx",
    "../components/WorkspaceSummary.tsx",
    "../components/StagingLink.tsx",
    "../components/WorkspaceInfo.tsx",
  ]) {
    const file = await source(path);
    expect(file).toContain(
      "const pendingCreation = useSessionPendingCreation();",
    );
    for (const call of file.matchAll(
      /useSession(?:Pr|Git)Resource\([\s\S]*?enabled:([^\n]*)/g,
    ))
      expect(call[1]).toContain("!pendingCreation");
  }
});
