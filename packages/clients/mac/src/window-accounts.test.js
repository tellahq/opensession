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
