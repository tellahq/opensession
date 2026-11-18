const { expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

test("switching organizations navigates only the requesting window", () => {
  const start = source.indexOf("function switchAccount(");
  const end = source.indexOf("function openHome(", start);
  const implementation = source.slice(start, end);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(implementation).toContain("windowData.get(target)");
  expect(implementation).toContain("loadApp(destination, showWindow(target))");
  expect(implementation).not.toContain("for (const appWindow of appWindows)");
});

test("window navigation is checked against that window's organization", () => {
  expect(source).toContain("accountId: account?.id || null");
  expect(source).toContain("inActiveWindow(url, createdWindow)");
  expect(source).toContain('accelerator: "CommandOrControl+N"');
});

test("removing an organization refuses the requesting window's own account", () => {
  const start = source.indexOf('ipcMain.handle("os1:organizations-remove"');
  const end = source.indexOf('ipcMain.on("os1:organizations-manage"', start);
  const implementation = source.slice(start, end);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(implementation).toContain("fromActiveOrganizationPicker(e)");
  expect(implementation).toContain(
    "accountForWindow(requester, stored)?.id === id",
  );
  expect(implementation).toContain("appWindow.destroy()");
  expect(implementation).toContain("syncBackgroundAccountWindows()");
  expect(implementation).toContain("buildAppMenu()");
});

test("only the shell's own pages can drive the server on this Mac", () => {
  const start = source.indexOf('ipcMain.handle("os1:local-server-status"');
  const end = source.indexOf("buildAppMenu();", start);
  const implementation = source.slice(start, end);

  expect(start).toBeGreaterThan(-1);
  expect(implementation).toContain("fromShellPage(e) ? localServerStatus()");
  for (const channel of ["retry", "logs"]) {
    const at = implementation.indexOf(`"os1:local-server-${channel}"`);
    expect(at).toBeGreaterThan(-1);
    expect(implementation.slice(at, at + 160)).toContain(
      'fromLocalPage(e, eventWindow(e), "local-server.html")',
    );
  }
  const use = implementation.slice(
    implementation.indexOf('"os1:local-server-use"'),
  );
  expect(use).toContain('fromLocalPage(e, target, "setup.html")');
  // Adding "This Mac" never replaces an organization that is already there.
  expect(use).not.toContain("writeStoredServer(");
});

test("a window for this Mac waits for its server instead of failing to load", () => {
  const start = source.indexOf("function loadApp(");
  const implementation = source.slice(start, source.indexOf("\n}\n", start));
  expect(implementation).toContain(
    'isLocalAccountUrl(url) && localServer.state !== "ready"',
  );
  expect(implementation).toContain("showLocalServerPage(target, url)");
});

test("quitting waits for the server on this Mac to stop", () => {
  const start = source.indexOf('app.on("before-quit"');
  const implementation = source.slice(
    start,
    source.indexOf('app.on("will-quit"', start),
  );
  expect(implementation).toContain("event.preventDefault()");
  expect(implementation).toContain(".finally(() => app.quit())");
  expect(source).toContain('app.on("will-quit", () => localServer.stopNow())');
});
