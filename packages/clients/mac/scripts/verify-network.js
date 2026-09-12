// Run with Electron, not Bun: exercises real BrowserWindows and IPC using
// disposable organizations and an injected Tailscale client. Never changes VPN.
const { app, BrowserWindow, Menu, dialog } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const tailscale = require("../src/tailscale");

const profiles = [
  {
    id: "personal",
    account: "alex@example.test",
    tailnet: "Personal",
    selected: true,
  },
  { id: "work", account: "alex@acme.test", tailnet: "Acme", selected: false },
];
let ready = Promise.resolve();
let failSwitch = false;
const switched = [];
tailscale.createTailscaleClient = () => ({
  list: async () => profiles,
  switch: async (id) => {
    if (failSwitch) throw new Error("Fixture switch failed");
    switched.push(id);
    for (const profile of profiles) profile.selected = profile.id === id;
  },
  ready: async () => ready,
});
const prompts = [];
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  prompts.push(options);
  return { response: options.type === "error" ? 2 : 0 };
};
// A test instance must not claim the installed app's protocol registration.
app.setAsDefaultProtocolClient = () => true;

async function until(get, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await get();
    if (value) return value;
    await delay(30);
  }
  throw new Error(`Timed out: ${message}`);
}

async function server(label) {
  const instance = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, organizationName: label }));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<!doctype html><title>${label}</title><h1>${label}</h1><p>Disposable Electron verification fixture</p>`,
      );
    }
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return { instance, url: `http://127.0.0.1:${instance.address().port}/` };
}

function organizationMenu() {
  return Menu.getApplicationMenu().items[0].submenu.items.find(
    (item) => item.label === "Organizations",
  ).submenu;
}

async function main() {
  const root = await fs.mkdtemp(path.join("/tmp", "os-network-verify-"));
  const personal = await server("Personal");
  const work = await server("Acme");
  app.setPath("appData", root);
  delete process.env.OS1_URL;
  const data = path.join(root, "Open Session");
  await fs.mkdir(data);
  const serverFile = path.join(data, "server.json");
  await fs.writeFile(
    serverFile,
    JSON.stringify({
      activeId: "personal",
      accounts: [
        {
          id: "personal",
          label: "Personal",
          url: personal.url,
          lastUrl: `${personal.url}session/notes`,
        },
        {
          id: "work",
          label: "Acme",
          url: work.url,
          lastUrl: `${work.url}session/project`,
        },
      ],
    }),
  );
  const stored = async () => JSON.parse(await fs.readFile(serverFile, "utf8"));
  try {
    require("../src/main");
    await app.whenReady();
    const window = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (candidate) =>
            candidate.isVisible() &&
            candidate.webContents.getURL().startsWith(personal.url),
        ),
      "initial organization",
    );
    assert.equal(
      await window.webContents.executeJavaScript("window.os1.network.state()"),
      null,
    );
    assert.deepEqual(
      await window.webContents.executeJavaScript(
        'window.os1.network.save("work", {profileId:"work",mode:"automatic"})',
      ),
      { ok: false },
    );

    organizationMenu()
      .items.find((item) => item.label === "Network on this Mac…")
      .click();
    const settings = await until(
      () =>
        BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().endsWith("/network.html"),
        ),
      "network settings window",
    );
    await until(
      () =>
        settings.webContents.executeJavaScript(
          '!document.getElementById("settings").hidden',
        ),
      "settings loaded",
    );
    const setBinding = async (id, mode) => {
      await settings.webContents.executeJavaScript(`
        document.getElementById("organization").value = ${JSON.stringify(id)};
        document.getElementById("organization").dispatchEvent(new Event("change"));
        document.getElementById("profile").value = ${JSON.stringify(id)};
        document.getElementById("profile").dispatchEvent(new Event("change"));
        document.getElementById("mode").value = ${JSON.stringify(mode)};
        document.getElementById("settings").requestSubmit();
      `);
      await until(
        async () =>
          (await stored()).accounts.find((account) => account.id === id)
            ?.network?.mode === mode,
        "saved binding",
      );
    };
    await setBinding("personal", "ask");
    await setBinding("work", "automatic");
    const proof = process.env.OS1_NETWORK_PROOF_DIR || root;
    await fs.mkdir(proof, { recursive: true });
    await until(() => settings.isVisible(), "settings visible");
    await fs.writeFile(
      path.join(proof, "network-settings.png"),
      (await settings.webContents.capturePage()).toPNG(),
    );
    settings.close();
    await until(() => settings.isDestroyed(), "settings closed");

    let release;
    ready = new Promise((resolve) => {
      release = resolve;
    });
    organizationMenu()
      .items.find((item) => item.label === "Acme")
      .click();
    const progress = await until(
      () =>
        BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().endsWith("/network.html"),
        ),
      "switch progress",
    );
    await until(
      () =>
        switched.length === 1 &&
        progress.webContents.executeJavaScript(
          'document.getElementById("title").textContent === "Switch to Acme"',
        ),
      "switch started",
    );
    console.log("[verify] switch pending before navigation");
    assert.equal((await stored()).activeId, "personal");
    await until(() => progress.isVisible(), "progress visible");
    console.log("[verify] capturing switch progress");
    await fs.writeFile(
      path.join(proof, "network-switch.png"),
      (await progress.webContents.capturePage()).toPNG(),
    );
    console.log("[verify] captured, releasing network readiness");
    release();
    await until(
      () => window.webContents.getURL() === `${work.url}session/project`,
      "destination route",
    );
    assert.deepEqual(switched, ["work"]);
    assert.equal(prompts.length, 0);
    assert.equal(
      (await stored()).accounts.find((account) => account.id === "personal")
        .lastUrl,
      `${personal.url}session/notes`,
    );

    // Ask mode and returning to the saved route.
    organizationMenu()
      .items.find((item) => item.label === "Personal")
      .click();
    await until(
      () => window.webContents.getURL() === `${personal.url}session/notes`,
      "return route",
    );
    assert.equal(
      prompts.filter((options) => options.type === "warning").length,
      1,
    );
    assert.deepEqual(switched, ["work", "personal"]);

    // Focusing/reloading a background account must not trigger another switch.
    const background = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.isVisible() &&
            candidate.webContents.getURL().startsWith(work.url),
        ),
      "background organization loaded",
    );
    await background.webContents.executeJavaScript(
      'window.os1.organizations.switch("work")',
    );
    await delay(100);
    assert.deepEqual(switched, ["work", "personal"]);

    // A failed switch leaves the requesting window and persisted account alone.
    failSwitch = true;
    organizationMenu()
      .items.find((item) => item.label === "Acme")
      .click();
    await until(
      () => prompts.some((options) => options.type === "error"),
      "failure dialog",
    );
    assert.equal((await stored()).activeId, "personal");
    assert.equal(window.webContents.getURL(), `${personal.url}session/notes`);
    console.log(`Electron network verification passed. Proof: ${proof}`);
  } finally {
    personal.instance.close();
    work.instance.close();
  }
}

main()
  .then(() => {
    app.quit();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.quit();
    app.exit(1);
  });
