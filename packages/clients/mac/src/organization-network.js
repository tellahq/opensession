const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { BrowserWindow, ipcMain, dialog, shell } = require("electron");
const {
  readNetworkBinding,
  createTailscaleClient,
  connectOrganizationNetwork,
} = require("./tailscale");

const page = path.join(__dirname, "network.html");

class OrganizationNetwork {
  constructor({ readAccounts, writeAccounts, probe }) {
    this.readAccounts = readAccounts;
    this.writeAccounts = writeAccounts;
    this.probe = probe;
    this.client = createTailscaleClient();
    this.windows = new Map();
    this.settings = null;

    // No remote renderer can enumerate Tailscale accounts or edit a binding.
    // Only the main frame of a window created by this controller is admitted.
    const sender = (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (
        !this.windows.has(window) ||
        event.senderFrame !== event.sender.mainFrame
      )
        return null;
      const url = new URL(event.senderFrame.url);
      url.search = "";
      return url.href === pathToFileURL(page).href ? window : null;
    };
    ipcMain.handle("os1:network-state", async (event) => {
      const window = sender(event);
      const state = this.windows.get(window);
      if (!state) return null;
      if (state.kind !== "settings") return state;
      let profiles = [];
      let error = null;
      try {
        profiles = await this.client.list();
      } catch (cause) {
        error = cause.message;
      }
      return {
        ...state,
        accounts: this.readAccounts().accounts.map(
          ({ id, label, network }) => ({ id, label, network }),
        ),
        profiles,
        error,
      };
    });
    ipcMain.handle("os1:network-save", async (event, id, value) => {
      const window = sender(event);
      if (this.windows.get(window)?.kind !== "settings") return { ok: false };
      const binding = value === null ? null : readNetworkBinding(value);
      if (value !== null && !binding)
        return {
          ok: false,
          error: "Choose a saved Tailscale account and switching mode.",
        };
      try {
        if (
          binding &&
          !(await this.client.list()).some(
            (profile) => profile.id === binding.profileId,
          )
        ) {
          return {
            ok: false,
            error:
              "That Tailscale account is no longer saved. Refresh the account list.",
          };
        }
        if (window.isDestroyed()) return { ok: false };
        // Re-read after CLI work so a route or account update is never lost.
        const stored = this.readAccounts();
        const account = stored.accounts.find(
          (candidate) => candidate.id === id,
        );
        if (!account)
          return { ok: false, error: "That organization is no longer saved." };
        if (binding) account.network = binding;
        else delete account.network;
        if (!this.writeAccounts(stored))
          return { ok: false, error: "Couldn't save this network setting." };
        return { ok: true };
      } catch (cause) {
        return { ok: false, error: cause.message };
      }
    });
    ipcMain.on("os1:network-close", (event) => sender(event)?.close());
    ipcMain.on("os1:network-open-tailscale", (event) => {
      if (sender(event)) void this.openTailscale();
    });
  }

  async openTailscale() {
    const error = await shell.openPath("/Applications/Tailscale.app");
    if (error)
      await dialog.showMessageBox({
        type: "info",
        message: "Open Tailscale",
        detail:
          "Open your installed Tailscale app, or install it in Applications first.",
      });
  }

  createWindow(parent, state) {
    const window = new BrowserWindow({
      width: 520,
      height: state.kind === "settings" ? 640 : 360,
      title:
        state.kind === "settings"
          ? "Network on this Mac"
          : "Switch organization",
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.windows.set(window, state);
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("closed", () => {
      this.windows.delete(window);
      if (this.settings === window) this.settings = null;
    });
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    void window.loadFile(page);
    return window;
  }

  showSettings(parent, accountId) {
    if (this.settings && !this.settings.isDestroyed()) {
      this.settings.show();
      this.settings.focus();
      return;
    }
    this.settings = this.createWindow(parent, { kind: "settings", accountId });
  }

  async prepare(account, parent, isLatest, signal) {
    if (!readNetworkBinding(account.network)) return true;
    const progress = this.createWindow(parent, {
      kind: "progress",
      label: account.label,
      message: "Checking Tailscale…",
    });
    const close = () => {
      if (!progress.isDestroyed()) progress.destroy();
    };
    const closed = new AbortController();
    progress.once("closed", () => closed.abort());
    signal.addEventListener("abort", close, { once: true });
    const dialogSignal = AbortSignal.any([signal, closed.signal]);
    const isCurrent = () =>
      isLatest() && !parent.isDestroyed() && !progress.isDestroyed();
    const status = (message) => {
      if (!isCurrent()) return;
      const state = { kind: "progress", label: account.label, message };
      this.windows.set(progress, state);
      progress.webContents.send("os1:network-state", state);
    };
    try {
      while (isCurrent()) {
        try {
          return (
            (await connectOrganizationNetwork({
              account,
              client: this.client,
              probe: this.probe,
              isCurrent,
              status,
              confirm: async (profile) => {
                if (!isCurrent()) return false;
                const { response } = await dialog.showMessageBox(progress, {
                  type: "warning",
                  signal: dialogSignal,
                  message: `Switch Tailscale to ${profile.tailnet}?`,
                  detail: `Use ${profile.account} for ${account.label}. This changes networking for the whole Mac. Other apps and organization windows may disconnect.`,
                  buttons: ["Switch network", "Cancel"],
                  defaultId: 0,
                  cancelId: 1,
                });
                return response === 0;
              },
            })) === true && isCurrent()
          );
        } catch (cause) {
          if (!isCurrent()) return false;
          status("Couldn't connect");
          const { response } = await dialog.showMessageBox(progress, {
            type: "error",
            signal: dialogSignal,
            message: `Couldn't connect to ${account.label}`,
            detail: `${cause.message}\n\nYour previous Tailscale account is not restored automatically.`,
            buttons: ["Retry", "Open Tailscale", "Cancel"],
            defaultId: 0,
            cancelId: 2,
          });
          if (!isCurrent() || response === 2) return false;
          if (response === 1) {
            await this.openTailscale();
            return false;
          }
        }
      }
      return false;
    } finally {
      signal.removeEventListener("abort", close);
      close();
    }
  }
}

module.exports = { OrganizationNetwork };
