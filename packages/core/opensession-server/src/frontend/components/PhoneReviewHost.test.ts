import { expect, test } from "bun:test";

const app = await Bun.file(
  new URL("../AppContent.tsx", import.meta.url),
).text();
const workspace = await Bun.file(
  new URL("./WorkspacePane.tsx", import.meta.url),
).text();
const session = await Bun.file(
  new URL("./session-viewer/SessionViewerMainRegion.tsx", import.meta.url),
).text();

test("focused phone Review replaces the title chrome but keeps workspace tabs", () => {
  const condition = app.slice(
    app.indexOf("const focusedPhoneReview ="),
    app.indexOf("const content ="),
  );
  expect(condition).toContain("isPhone &&");
  expect(condition).toContain('route.view === "session" && !!currentSession');
  expect(condition).toContain("routeWorkspace &&");
  expect(condition).toContain("reviewActive &&");
  expect(condition).toContain(
    'route.view === "pr" && route.branch !== undefined',
  );
  expect(app).toContain('focusedPhoneReview && "phone:hidden"');
  expect(condition).toContain("routeWorkspace.branch || reviewFocusPr?.branch");
  expect(app).toContain("{!focusedPhoneReview && (");
  expect(app).toContain("!activeTabSplit && tabStripVisible && (");
  expect(app).toContain("{renderTabBar(null)}");
  expect(app).toContain("{renderTabBar(side)}");
  expect(app).not.toContain("{!focusedPhoneReview && renderTabBar(side)}");
  expect(app).toMatch(
    /focusedPhoneReview &&\s*"phone:pt-\[env\(safe-area-inset-top,0px\)\]"/,
  );
  expect(app).toContain("onBack={() => setActiveViewTab(null)}");
});

test("both Review hosts supply a visible workspace exit and preserve safe-area clearance", () => {
  for (const source of [workspace, session]) {
    expect(source).toContain("phoneNavigation={");
    expect(source).toContain("<PhoneTopBarAction");
    expect(source).toContain('aria-label="Back to workspace"');
    expect(source).toMatch(
      /isPhone &&\s*!tabStripVisible &&\s*"phone:pt-\[env\(safe-area-inset-top,0px\)\]"/,
    );
  }
  expect(workspace).toContain("onClick={onBack}");
  expect(session).toContain("onClick={openCurrentWorkspace}");
});

test("direct PR preview retains a phone back action and safe-area inset", async () => {
  const preview = await Bun.file(
    new URL("./PrQueuePreview.tsx", import.meta.url),
  ).text();
  expect(app).toContain("onBack={goBack}");
  expect(preview).toContain("phoneNavigation={");
  expect(preview).toContain("onClick={onBack}");
  expect(preview).toContain('aria-label="Back"');
  expect(preview).toContain("phone:pt-[env(safe-area-inset-top,0px)]");
});

test("PR route adapter keeps unresolved links outside the review canvas", async () => {
  const preview = await Bun.file(
    new URL("./PrQueuePreview.tsx", import.meta.url),
  ).text();
  expect(app).toContain("<PrRoutePreview");
  expect(app).toContain("missing={prRefMissing}");
  expect(preview).toContain("if (route.branch === undefined)");
  expect(preview).toContain("return missing ? (");
  expect(preview).toContain("key={`${route.repo}:${route.branch}`}");
  expect(preview).toContain("await refreshWorkspaces()");
  expect(preview).toContain('navigate({ view: "workspace", id: workspaceId })');
});
