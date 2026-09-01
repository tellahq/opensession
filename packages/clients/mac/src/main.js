// Open Session desktop — a thin shell around an Open Session server. The frontend ships
// from the server, so this app only owns the window, navigation policy,
// notifications, badge and links.
const {
  app,
  BrowserWindow,
  shell,
  session,
  ipcMain,
  autoUpdater,
  systemPreferences,
  powerMonitor,
  Menu,
  clipboard,
  dialog,
  screen,
  net,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { NativeDictation } = require("./native-dictation");
const {
  accountForContext,
  isOpenSessionAppUrl,
  resumableAccountUrl,
} = require("./account-navigation");
const packageConfig = require("../package.json").opensession || {};
const nativeDictation = new NativeDictation();

// AppKit can show its persistent-window crash-recovery prompt before Electron
// finishes launching. On macOS 26 that modal can trap the browser process and
// leave the app in a startup crash loop. Open Session restores its own window bounds, so
// native persistent UI state is both redundant and unsafe here.
if (process.platform === "darwin") {
  systemPreferences.setUserDefault(
    "ApplePersistenceIgnoreState",
    "boolean",
    true,
  );
}

// Which Open Session server this shell is a window onto. It is asked for on the
// first launch and kept in the profile from then on (see "Choosing a server"
// below), because a shell that only ever knows the address it was built with is
// no use to anyone running their own instance.
//
// The packaged default seeds that first screen rather than deciding it: a
// distributor sets it with OS1_CLOUD_URL or `opensession.defaultServer` in
// package.json, and the portable fallback is a server on this machine. OS1_URL
// overrides the stored address for one run without changing it, which is what
// scripts/app-dev.ts uses.
const DEFAULT_URL =
  normalizeServerUrl(process.env.OS1_CLOUD_URL) ||
  normalizeServerUrl(packageConfig.defaultServer) ||
  "http://127.0.0.1:3850/";
const RUN_URL = normalizeServerUrl(process.env.OS1_URL);

// Null until a server is chosen: the window opens on the setup page instead,
// and every origin check here fails closed in the meantime.
let APP_URL = null;
let APP_ORIGIN = null;
// Only the app itself. Sign-in is a device code entered on github.com, and
// that belongs in the browser the person is already signed into GitHub in,
// not in this window, where it would navigate the app away from the screen
// that is waiting for the code.
let IN_WINDOW_ORIGINS = [];

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

// The profile folder is this shell's storage identity, and it is deliberately
// NOT the app's name. Electron derives the user-data folder from CFBundleName
// (GetApplicationName reads it straight out of the Info.plist), so every rename
// otherwise points the app at an empty folder and orphans everything a person
// had set up: window bounds, zoom, notification grant, preferences, drafts.
// That is what the 0.3.13 rename cost. Pin it here instead — the label on the
// app can change as often as design likes, and the profile stays put.
//
// `sessionData` is pinned too. It defaults to userData but is a separate path
// key, so overriding userData alone would leave cookies, localStorage and the
// disk cache behind in a second folder named after the current label.
const PROFILE_DIR_NAME = "Open Session";
app.setPath("userData", path.join(app.getPath("appData"), PROFILE_DIR_NAME));
app.setPath("sessionData", app.getPath("userData"));

// One thing a rename still costs, and no code here can avoid it: macOS
// encrypts the cookie jar with a Keychain key named after the app ("<name> Safe
// Storage"), which Electron resolves from the bundle name before this file is
// loaded. A renamed app cannot read what the old name wrote, so signing in
// again once is the price of each rename.
//
// Installs that never reached 0.3.13 still have their state under the original
// name. Carry it across on the first launch that finds nothing in its place.
// Caches stay behind: they rebuild themselves, and copying them would only slow
// the launch.
const LEGACY_APP_NAME = "OS\u00b9";
// The entries that are state rather than cache: this shell's bounds and zoom,
// the web app's per-user preferences and unsent drafts, and Chromium's own
// preferences, which hold the notification grant.
const MIGRATED_STATE = ["window-state.json", "Local Storage", "Preferences"];

function adoptLegacyUserData() {
  const current = app.getPath("userData");
  const legacy = path.join(path.dirname(current), LEGACY_APP_NAME);
  if (legacy === current) return;
  for (const entry of MIGRATED_STATE) {
    const from = path.join(legacy, entry);
    const to = path.join(current, entry);
    // Whole entries only, and never over one that is already there. "Local
    // Storage" is a LevelDB directory, so merging one into another file by file
    // would corrupt it, and anyone already using the renamed app keeps what
    // they have.
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(current, { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    } catch {}
  }
}

// Before the profile is created, which is why it runs at load rather than on
// ready: Chromium reads these files as it opens the session.
adoptLegacyUserData();

// Visible app windows share Chromium's profile (auth, preferences and drafts),
// but each renderer owns both its organization and route. `win` is the most
// recently focused one and is only a fallback for actions, such as deep links
// and app-menu commands, that do not name a window.
let win = null;
const appWindows = new Set();
const windowData = new WeakMap();
let quitting = false;
let appReady = false;
let pendingDeepLink = null;

function activeWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && appWindows.has(focused) && !focused.isDestroyed())
    return focused;
  if (win && appWindows.has(win) && !win.isDestroyed()) return win;
  return (
    [...appWindows].findLast((candidate) => !candidate.isDestroyed()) || null
  );
}

function eventWindow(event) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return owner && appWindows.has(owner) && !owner.isDestroyed() ? owner : null;
}

// ---- Choosing a server ------------------------------------------------------
// Which server this shell talks to belongs to the person using it, not to
// whoever built the app. It is asked once, on the first launch, and kept in the
// profile from then on; the app menu and the status page bring the question
// back.

const serverFile = () => path.join(app.getPath("userData"), "server.json");
let backgroundAccountWindows = new Map();
let badgeByOrigin = new Map();

// Declarations rather than consts: DEFAULT_URL calls into these while this
// module is still evaluating, and a const would still be in its dead zone.
function hasScheme(raw) {
  return /^https?:\/\//i.test(String(raw ?? "").trim());
}

// People type a host, not a URL, and they paste whole session links. Both
// resolve to the origin: the app serves at the root of its host, so keeping a
// path would send every later navigation through it.
function normalizeServerUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const typed = hasScheme(text);
  // A scheme this cannot speak is a typo, not a host by that name.
  if (!typed && /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  try {
    // https for anything that did not say, since anything off this machine
    // will be. An instance on a LAN or a tailnet that is not is found by the
    // probe, which retries without the s and keeps whichever answered.
    const url = new URL(typed ? text : `https://${text}`);
    if (!url.hostname) return null;
    // A server on this machine is plain http, and someone typing
    // "localhost:3850" should not have to know to say so.
    if (!typed && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      url.protocol = "http:";
    }
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

function readStoredAccounts() {
  try {
    const stored = JSON.parse(fs.readFileSync(serverFile(), "utf8"));
    if (Array.isArray(stored?.accounts) && stored.accounts.length) {
      const accounts = stored.accounts.flatMap((account) => {
        const url = normalizeServerUrl(account?.url);
        if (!url) return [];
        return [
          {
            id: String(account.id || crypto.randomUUID()),
            label: String(account.label || new URL(url).host),
            url,
            lastUrl: resumableAccountUrl(url, account.lastUrl),
          },
        ];
      });
      if (accounts.length) {
        const activeId = accounts.some(
          (account) => account.id === stored.activeId,
        )
          ? stored.activeId
          : accounts[0].id;
        return { accounts, activeId };
      }
    }
    const legacyURL = normalizeServerUrl(stored?.url);
    if (legacyURL) {
      const account = {
        id: crypto.randomUUID(),
        label: new URL(legacyURL).host,
        url: legacyURL,
      };
      const migrated = { accounts: [account], activeId: account.id };
      fs.writeFileSync(serverFile(), JSON.stringify(migrated, null, 2));
      return migrated;
    }
  } catch {}
  return { accounts: [], activeId: null };
}

function writeStoredAccounts(accounts) {
  try {
    fs.mkdirSync(path.dirname(serverFile()), { recursive: true });
    fs.writeFileSync(serverFile(), JSON.stringify(accounts, null, 2));
    return true;
  } catch (err) {
    console.error("[server] could not save", err);
    return false;
  }
}

function activeAccountResumeUrl() {
  const stored = readStoredAccounts();
  const account = stored.accounts.find(
    (candidate) => candidate.id === stored.activeId,
  );
  return account?.lastUrl || account?.url || APP_URL;
}

function accountForWindow(target, stored = readStoredAccounts()) {
  return accountForContext(
    stored.accounts,
    stored.activeId,
    target && windowData.get(target)?.accountId,
    target?.webContents.getURL(),
  );
}

function accountUrlForWindow(target) {
  return accountForWindow(target)?.url || APP_URL;
}

// pushState changes the renderer's URL without a document load, so local web
// state alone is not enough for the shell's next launch. Persist the route of
// the most recently focused app window whenever it changes.
function rememberWindowAccountUrl(target) {
  if (!target || target.isDestroyed() || target !== activeWindow()) return;
  const stored = readStoredAccounts();
  const account = accountForWindow(target, stored);
  if (!account) return;
  const next = resumableAccountUrl(account.url, target.webContents.getURL());
  if (!next || next === account.lastUrl) return;
  account.lastUrl = next;
  writeStoredAccounts(stored);
}

function rememberFocusedWindowAccount(target) {
  if (!target || target.isDestroyed()) return;
  const stored = readStoredAccounts();
  const account = accountForWindow(target, stored);
  if (!account) return;
  const data = windowData.get(target);
  if (data) data.accountId = account.id;
  if (stored.activeId !== account.id) {
    stored.activeId = account.id;
    writeStoredAccounts(stored);
  }
  rememberWindowAccountUrl(target);
  syncBackgroundAccountWindows();
  buildAppMenu();
}

function readStoredServer() {
  const stored = readStoredAccounts();
  return (
    stored.accounts.find((account) => account.id === stored.activeId)?.url ||
    null
  );
}

function writeStoredServer(url, addingAccount = false, accountID = null) {
  const stored = readStoredAccounts();
  const selectedID = accountID || stored.activeId;
  const active = stored.accounts.find((account) => account.id === selectedID);
  if (addingAccount || !active) {
    const account = { id: crypto.randomUUID(), label: new URL(url).host, url };
    stored.accounts.push(account);
    stored.activeId = account.id;
  } else {
    active.url = url;
    if (!active.label) active.label = new URL(url).host;
  }
  return writeStoredAccounts(stored);
}

// A profile that has been used before answered this question by working, so an
// update that adds the question must not put it to everyone whose app already
// opens. Only a profile with nothing in it is asked.
function adoptDefaultForExistingProfile() {
  if (readStoredServer() || !fs.existsSync(stateFile())) return;
  writeStoredServer(DEFAULT_URL);
}

function trustedAccountOrigins() {
  return readStoredAccounts().accounts.map(
    (account) => new URL(account.url).origin,
  );
}

function refreshAccountOrigins() {
  IN_WINDOW_ORIGINS = [...new Set(trustedAccountOrigins())];
  blockServiceWorker();
}

function setServer(url) {
  APP_URL = url;
  APP_ORIGIN = new URL(url).origin;
  refreshAccountOrigins();
}

// The web app's service worker only exists for Web Push, app-shell caching and
// the PWA badge, none of which function in Electron, and its Cache Storage
// writes crash Electron 43's renderer (bad CacheStorageCache Mojo message).
// Keep it out entirely; offline.html covers the offline case it would.
function blockServiceWorker() {
  if (!APP_ORIGIN) return;
  // A filter is fixed when its listener is registered and a session holds only
  // one of them, so re-registering is how the block follows a server change.
  session.defaultSession.webRequest.onBeforeRequest(
    {
      urls: [...new Set([APP_ORIGIN, ...trustedAccountOrigins()])].map(
        (origin) => origin + "/*sw.js*",
      ),
    },
    (_details, callback) => callback({ cancel: true }),
  );
}

// Does something answer as an Open Session server there? A mistyped address and
// an instance that is simply down are the same blank window otherwise, and only
// one of the two is worth saving.
async function probeServer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await net.fetch(new URL("api/health", url).toString(), {
      signal: controller.signal,
      credentials: "omit",
    });
    if (!res.ok)
      return { ok: false, error: `That address answered ${res.status}.` };
    // The health route is public and answers JSON, so a host that is something
    // else (a parked domain, a proxy's login wall) fails here rather than at
    // the first empty window.
    const body = await res.json();
    if (!body || typeof body !== "object") {
      return { ok: false, error: "That address isn't an Open Session server." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: null };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveServer(raw) {
  const url = normalizeServerUrl(raw);
  if (!url)
    return { ok: false, error: "That doesn't look like a server address." };
  const reached = await probeServer(url);
  if (reached.ok) return { ok: true, url };
  // A bare tailnet or LAN host often serves plain HTTP. Match the first-run
  // flow by trying it only when the person did not choose a scheme themselves.
  const plain = hasScheme(raw) ? null : url.replace(/^https:/, "http:");
  if (plain && (await probeServer(plain)).ok) return { ok: true, url: plain };
  return { ...reached, url };
}

function showSetup(
  returnDestination = "app",
  target = activeWindow(),
  addingAccount = false,
) {
  if (!target || target.isDestroyed()) return;
  const data = windowData.get(target);
  if (data) {
    data.setupReturnDestination = returnDestination;
    data.addingAccount = addingAccount;
  }
  const currentURL = accountUrlForWindow(target);
  clearStallGuard(target);
  target.loadFile(path.join(__dirname, "setup.html"), {
    query: {
      url: addingAccount ? "" : currentURL || DEFAULT_URL,
      // A later visit can be called off; the first run has nothing to go back
      // to.
      mode: addingAccount ? "add" : currentURL ? "change" : "first-run",
    },
  });
}

// ---- Auto-update ------------------------------------------------------------
// Electron's built-in Squirrel.Mac updater against the Open Session server's
// release proxy (src/server/routes/os1-update.ts server-side). The server
// serves Squirrel's static JSON feed; Squirrel compares versions and downloads
// the signed zip immediately when newer, so "available" doubles as
// "downloading". State mirrors to the renderer (window.os1.updates in preload.js),
// which shows the update toast and calls install to restart.
let updateState = { state: "idle", version: null };

function setUpdateState(next) {
  updateState = next;
  for (const target of appWindows) {
    if (!target.isDestroyed())
      target.webContents.send("os1:update-state", updateState);
  }
}

// True while a menu-initiated check is in flight: the periodic background
// check stays silent, but a manual one reports its outcome in dialogs
// (the toast only appears once an update is actually staged).
let manualCheck = false;
let updaterReady = false;

async function promptRestartToUpdate() {
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    message: "Update ready",
    detail: updateState.version
      ? `Open Session ${updateState.version} has been downloaded. Restart to install it.`
      : "An update has been downloaded. Restart to install it.",
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    quitting = true;
    autoUpdater.quitAndInstall();
  }
}

function checkForUpdatesFromMenu() {
  if (!updaterReady) {
    dialog.showMessageBox(win, {
      type: "info",
      message: "Updates unavailable",
      detail: app.isPackaged
        ? "The updater failed to initialize. Check the logs."
        : "Auto-update only works in the packaged, signed app.",
    });
    return;
  }
  if (updateState.state === "downloaded") {
    promptRestartToUpdate();
    return;
  }
  manualCheck = true;
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    manualCheck = false;
    dialog.showMessageBox(win, {
      type: "error",
      message: "Update check failed",
      detail: String(err),
    });
  }
}

function initAutoUpdate() {
  // Dev runs (`electron .`) are unsigned, and Squirrel refuses to initialize.
  if (!app.isPackaged || process.platform !== "darwin") return;
  // Called again once the first run has chosen a server, so the feed is only
  // ever armed against the instance actually in use.
  if (updaterReady || !APP_ORIGIN) return;
  try {
    autoUpdater.setFeedURL({
      // Updates come from the instance this shell is pointed at: every Open
      // Session server serves the release proxy, and a self-hosted one is
      // where its own build came from. Squirrel installs only a build signed
      // by the identity the running app carries, so following the address
      // does not widen who can hand this app a binary.
      url: `${APP_ORIGIN}/api/packages/clients/mac/update?version=${encodeURIComponent(app.getVersion())}`,
      serverType: "json",
    });
  } catch (err) {
    console.error("[update] setFeedURL failed", err);
    return;
  }
  updaterReady = true;
  autoUpdater.on("update-available", () => {
    setUpdateState({ state: "available", version: null });
    if (manualCheck) {
      // Keep manualCheck set: update-downloaded finishes the interaction.
      dialog.showMessageBox(win, {
        type: "info",
        message: "Update available",
        detail:
          "Downloading in the background. You'll be asked to restart when it's ready.",
      });
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(win, {
        type: "info",
        message: "You're up to date",
        detail: `Open Session ${app.getVersion()} is the latest version.`,
      });
    }
  });
  autoUpdater.on("update-downloaded", (_e, _notes, releaseName) => {
    setUpdateState({ state: "downloaded", version: releaseName || null });
    if (manualCheck) {
      manualCheck = false;
      promptRestartToUpdate();
    }
  });
  autoUpdater.on("error", (err) => {
    // Offline / tailnet-down is normal; log and retry on the next tick.
    console.error("[update]", err);
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(win, {
        type: "error",
        message: "Update check failed",
        detail: String(err),
      });
    }
  });
  const check = () => {
    if (updateState.state === "downloaded") return; // already staged
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      console.error("[update] check failed", err);
    }
  };
  // Give launch (and the tailnet) a moment before the first check.
  setTimeout(check, 15 * 1000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    showWindow();
    const url = argv.find((a) => a.startsWith("os1://"));
    if (url) openDeepLink(url);
  });
}

app.setAsDefaultProtocolClient("os1");

const MIN_WIDTH = 700;
const MIN_HEIGHT = 480;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// With nothing saved yet, take most of the display. This is a working surface
// people keep open all day, and a fixed size small enough for a laptop is a
// third of the screen on anything bigger.
function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = clamp(Math.round(workArea.width * 0.9), MIN_WIDTH, 1760);
  const height = clamp(Math.round(workArea.height * 0.92), MIN_HEIGHT, 1160);
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

// Displays come and go. Bounds saved on a monitor that is now unplugged would
// open the window off screen, or bigger than the screen that is left, and both
// read as the app failing to open.
function onScreenBounds(saved) {
  const bounds = {
    x: Math.round(Number(saved?.x)),
    y: Math.round(Number(saved?.y)),
    width: Math.round(Number(saved?.width)),
    height: Math.round(Number(saved?.height)),
  };
  if (Object.values(bounds).some((n) => !Number.isFinite(n))) return null;
  const area = screen.getDisplayMatching(bounds).workArea;
  const shownWidth =
    Math.min(bounds.x + bounds.width, area.x + area.width) -
    Math.max(bounds.x, area.x);
  const shownHeight =
    Math.min(bounds.y + bounds.height, area.y + area.height) -
    Math.max(bounds.y, area.y);
  if (shownWidth < 200 || shownHeight < 100) return null;
  bounds.width = clamp(bounds.width, MIN_WIDTH, area.width);
  bounds.height = clamp(bounds.height, MIN_HEIGHT, area.height);
  return bounds;
}

function cascadeWindowBounds(bounds) {
  if (!appWindows.size) return bounds;
  const area = screen.getDisplayMatching(bounds).workArea;
  const offset = 24 * (1 + ((appWindows.size - 1) % 6));
  const shift = (position, size, start, available) => {
    if (position + size + offset <= start + available) return position + offset;
    if (position - offset >= start) return position - offset;
    return position;
  };
  return {
    ...bounds,
    x: shift(bounds.x, bounds.width, area.x, area.width),
    y: shift(bounds.y, bounds.height, area.y, area.height),
  };
}

function loadWindowState() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {}
  return {
    bounds: onScreenBounds(saved) || defaultBounds(),
    maximized: saved?.maximized === true,
    fullScreen: saved?.fullScreen === true,
    zoomLevel: clampZoom(saved?.zoomLevel),
  };
}

// A corrupt or hand-edited state file must not be able to leave the app at a
// zoom nobody can read their way out of.
function clampZoom(value) {
  return Number.isFinite(value) ? Math.min(4, Math.max(-3, value)) : 0;
}

function saveWindowState(target = activeWindow()) {
  if (!target || target.isDestroyed()) return;
  const data = windowData.get(target);
  let currentZoom = data?.zoomLevel ?? 0;
  try {
    if (!target.webContents.isDestroyed()) {
      currentZoom = target.webContents.getZoomLevel();
      if (data) data.zoomLevel = currentZoom;
    }
  } catch {}
  try {
    const state = {
      ...target.getNormalBounds(),
      maximized: target.isMaximized(),
      fullScreen: target.isFullScreen(),
      zoomLevel: clampZoom(currentZoom),
    };
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch {}
}

// Written whenever a window settles, not only at quit: a force quit, a crash
// or an update restart would otherwise throw away the size you just set, and
// opening where you left off is the whole point of saving it.
function scheduleSaveWindowState(target) {
  const data = windowData.get(target);
  if (!data) return;
  clearTimeout(data.saveTimer);
  data.saveTimer = setTimeout(() => saveWindowState(target), 400);
}

function inWindow(url) {
  try {
    return IN_WINDOW_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function inActiveWindow(url, target = activeWindow()) {
  const accountURL = accountUrlForWindow(target);
  return accountURL ? isOpenSessionAppUrl(accountURL, url) : false;
}

// Sign-in pages for external services (e.g. the ChatGPT device-code sign-in
// from Settings → Providers). The default browser is often not where you're
// logged into these accounts, so prefer Chrome and fall back to the default
// browser when it isn't installed. github.com is NOT in this list: it is also
// where every PR and docs link goes, and those belong in whichever browser
// the person actually uses.
const CHROME_AUTH_HOSTS = ["auth.openai.com"];

function openExternal(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  if (process.platform === "darwin" && CHROME_AUTH_HOSTS.includes(host)) {
    execFile("open", ["-a", "Google Chrome", url], (err) => {
      if (err) shell.openExternal(url);
    });
    return;
  }
  shell.openExternal(url);
}

// ---- Microphone -------------------------------------------------------------
// Dictation needs two grants: this shell's permission handler above, and macOS
// itself. macOS only ever asks once — after a "Don't Allow" it answers every
// later request instantly and silently, which the web app can only report as a
// bare "Microphone permission denied". Say what actually happened and offer the
// one place that can undo it.
let micDialogOpen = false;

function openMicSettings() {
  shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  );
}

async function explainMicDenied() {
  if (micDialogOpen) return;
  micDialogOpen = true;
  try {
    const { response } = await dialog.showMessageBox(
      win && !win.isDestroyed() ? win : null,
      {
        type: "info",
        message: "macOS is blocking the microphone",
        // app.getName() rather than the product name: what System Settings lists
        // is the bundle's label, so this text has to follow the label.
        detail:
          `Dictation needs microphone access, and macOS has it turned off for ${app.getName()}.\n\n` +
          `Open System Settings → Privacy & Security → Microphone, switch ${app.getName()} on, ` +
          "then quit and reopen it.",
        buttons: ["Open System Settings", "Not now"],
        defaultId: 0,
        cancelId: 1,
      },
    );
    if (response === 0) openMicSettings();
  } finally {
    micDialogOpen = false;
  }
}

async function micAccessAllowed() {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted" || status === "unknown") return true;
  // The system prompt only appears while the answer is still open. Declining it
  // is a deliberate no, so that path doesn't get the settings nudge.
  if (status === "not-determined") {
    return systemPreferences.askForMediaAccess("microphone");
  }
  void explainMicDenied();
  return false;
}

// os1://session/abc → <focused instance>/session/abc; app links pass through.
function deepLinkToUrl(raw, target = activeWindow()) {
  const accountURL = accountUrlForWindow(target);
  if (!accountURL) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === "os1:") {
      const destination = new URL(accountURL);
      destination.pathname = "/" + (u.host || "") + u.pathname;
      destination.search = u.search;
      destination.hash = u.hash;
      return destination.toString();
    }
    if (inActiveWindow(raw, target)) return raw;
  } catch {}
  return null;
}

function openDeepLink(raw) {
  // Held rather than dropped while the app is still starting, or while the
  // first run is being asked which server the link belongs to.
  if (!appReady || !APP_URL) {
    pendingDeepLink = raw;
    return;
  }
  try {
    const incoming = new URL(raw);
    if (incoming.protocol === "http:" || incoming.protocol === "https:") {
      const stored = readStoredAccounts();
      const account = stored.accounts.find(
        (candidate) => new URL(candidate.url).origin === incoming.origin,
      );
      const target = showWindow();
      if (account && account.id !== accountForWindow(target, stored)?.id) {
        switchAccount(account.id, raw, target);
        return;
      }
    }
  } catch {}
  const target = showWindow();
  const url = deepLinkToUrl(raw, target);
  if (!url) return;
  loadApp(url, target);
}

// Answers whether there was one, so a caller that would otherwise load the app
// itself can let the link say where to land instead.
function flushPendingDeepLink() {
  if (!pendingDeepLink) return false;
  const raw = pendingDeepLink;
  pendingDeepLink = null;
  openDeepLink(raw);
  return true;
}

function showWindow(target = activeWindow()) {
  if (!target || target.isDestroyed()) {
    return appReady ? createWindow() : null;
  }
  const data = windowData.get(target);
  if (data?.ready) {
    // show() alone leaves a minimized window in the Dock, so a deep link or a
    // notification click would land on a window nobody can see.
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    // The window is only half of it on macOS: an app that is not frontmost
    // stays behind the one that is until it asks for the activation itself.
    app.focus({ steal: true });
  }
  return target;
}

function showStatusPage(target = activeWindow()) {
  if (!target || target.isDestroyed()) return;
  clearStallGuard(target);
  target.loadFile(path.join(__dirname, "offline.html"), {
    query: { url: accountUrlForWindow(target) },
  });
}

// A navigation that neither commits nor fails leaves an empty window with no
// way back. The shell is transparent, so an unpainted renderer shows the raw
// window material and nothing else: no splash, and no status page either,
// because `did-fail-load` only reports an error and Chromium waits out a
// black-holed connection for a minute or more before it calls one. That is the
// ordinary way an instance behind a VPN goes away rather than a rare one, since
// its DNS record keeps resolving after the network behind it is gone. The web
// app rides its service worker's cached shell through exactly this stall; this
// shell blocks that worker (Electron 43's renderer crashes on Cache Storage
// writes), so it needs a deadline of its own.
const LOAD_STALL_MS = 8000;

function clearStallGuard(target) {
  const data = windowData.get(target);
  if (!data?.stallTimer) return;
  clearTimeout(data.stallTimer);
  data.stallTimer = null;
}

// The deadline is on the main frame committing, not on the page finishing to
// load: once the document arrives its splash paints, and a big bundle on a slow
// but working connection must not be swapped out for the status page.
function armStallGuard(target) {
  const data = windowData.get(target);
  if (!data) return;
  clearStallGuard(target);
  data.stallTimer = setTimeout(() => {
    data.stallTimer = null;
    showStatusPage(target);
  }, LOAD_STALL_MS);
}

// Every main-frame load the shell starts goes through here, so a hung
// navigation always has a way back.
function loadApp(url, target = activeWindow()) {
  if (!target || target.isDestroyed()) return;
  armStallGuard(target);
  target.loadURL(url);
}

function createWindow(initialURL = null, initialAccountID = null) {
  const state = loadWindowState();
  const stored = readStoredAccounts();
  let account = stored.accounts.find(
    (candidate) => candidate.id === initialAccountID,
  );
  if (initialURL) {
    try {
      const initialOrigin = new URL(initialURL).origin;
      account =
        stored.accounts.find(
          (candidate) => new URL(candidate.url).origin === initialOrigin,
        ) || account;
    } catch {}
  }
  account ||= stored.accounts.find(
    (candidate) => candidate.id === stored.activeId,
  );
  const createdWindow = new BrowserWindow({
    ...cascadeWindowBounds(state.bounds),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    fullscreen: state.fullScreen,
    // The web app keeps its workspace opaque and reveals this native material
    // only through the sidebar and narrow outer gutter. Unlike the original
    // vibrancy pass, the renderer does not add CSS backdrop filters on top.
    transparent: true,
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    // Do not expose the raw material before Chromium has painted its first
    // frame; this avoids a bright launch flash when the system is in light mode.
    show: false,
    // The frontend already lays itself out for Window Controls Overlay (its PWA
    // manifest declares display_override: window-controls-overlay).
    titleBarStyle: "hidden",
    titleBarOverlay: true,
    // No dedicated titlebar band in the frontend: its first content row (48px)
    // is the titlebar, so center the ~12px traffic lights on it ((48 - 12) / 2).
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const data = {
    ready: false,
    zoomLevel: state.zoomLevel,
    stallTimer: null,
    saveTimer: null,
    addingAccount: false,
    setupReturnDestination: "app",
    accountId: account?.id || null,
  };
  appWindows.add(createdWindow);
  windowData.set(createdWindow, data);
  win = createdWindow;

  if (state.maximized && !state.fullScreen) createdWindow.maximize();

  for (const settled of [
    "resize",
    "move",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ]) {
    createdWindow.on(settled, () => scheduleSaveWindowState(createdWindow));
  }

  createdWindow.on("focus", () => {
    win = createdWindow;
    rememberFocusedWindowAccount(createdWindow);
  });
  createdWindow.once("ready-to-show", () => {
    if (createdWindow.isDestroyed()) return;
    data.ready = true;
    createdWindow.show();
    createdWindow.focus();
  });

  // Chromium drops the zoom level on a cross-origin load (the status page is
  // one), so it is restored per load rather than once at startup.
  createdWindow.webContents.on("did-finish-load", () => {
    if (createdWindow.isDestroyed()) return;
    createdWindow.webContents.setZoomLevel(clampZoom(data.zoomLevel));
    if (inActiveWindow(createdWindow.webContents.getURL(), createdWindow)) {
      const accountID = windowData.get(createdWindow)?.accountId;
      if (accountID) refreshAccountLabel(accountID, createdWindow.webContents);
    }
  });
  // A commit means the server answered, so the stall guard's job is done —
  // whatever the page does from here is the app's own to report. In-app router
  // changes are a separate Electron event because they use history.pushState.
  createdWindow.webContents.on("did-navigate", () => {
    clearStallGuard(createdWindow);
    rememberWindowAccountUrl(createdWindow);
  });
  createdWindow.webContents.on("did-navigate-in-page", () => {
    rememberWindowAccountUrl(createdWindow);
  });
  // Pinch and wheel zoom land in the renderer, so the level has to be read back
  // a tick later; the View menu's roles are picked up by saveWindowState.
  createdWindow.webContents.on("zoom-changed", () => {
    setTimeout(() => {
      if (createdWindow.isDestroyed()) return;
      data.zoomLevel = clampZoom(createdWindow.webContents.getZoomLevel());
    }, 0);
  });

  createdWindow.on("close", (event) => {
    if (quitting) return;
    saveWindowState(createdWindow);
    // Keep the established Mac behavior for the last workspace: closing it
    // hides the app without discarding its route or drafts. Extra windows close
    // normally so hidden renderers do not accumulate.
    if (appWindows.size === 1) {
      event.preventDefault();
      createdWindow.hide();
    }
  });
  createdWindow.on("closed", () => {
    clearTimeout(data.saveTimer);
    clearStallGuard(createdWindow);
    appWindows.delete(createdWindow);
    if (win === createdWindow) win = activeWindow();
    syncBackgroundAccountWindows();
  });

  // Keep app-page navigation in-window. Same-origin documents such as raw
  // reports, assets and downloads still belong in the default browser,
  // alongside the device-code page, PR links and docs.
  createdWindow.webContents.on("will-navigate", (e, url) => {
    if (!inActiveWindow(url, createdWindow)) {
      e.preventDefault();
      openExternal(url);
      return;
    }
    // The status page navigates back to the app on its own, and that retry can
    // stall the same way the first load did.
    armStallGuard(createdWindow);
  });
  createdWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (inActiveWindow(url, createdWindow)) {
      createWindow(url, data.accountId);
      return { action: "deny" };
    }
    openExternal(url);
    return { action: "deny" };
  });

  // Native right-click menu (copy link, copy, paste, …) — Electron shows
  // nothing by default.
  createdWindow.webContents.on("context-menu", (_e, params) => {
    const items = [];

    if (params.linkURL) {
      items.push(
        {
          label: "Open Link in Browser",
          click: () => openExternal(params.linkURL),
        },
        {
          label: "Copy Link",
          click: () => clipboard.writeText(params.linkURL),
        },
        { type: "separator" },
      );
    }

    if (params.hasImageContents && params.srcURL) {
      items.push(
        {
          label: "Copy Image",
          click: () =>
            createdWindow.webContents.copyImageAt(params.x, params.y),
        },
        {
          label: "Copy Image Address",
          click: () => clipboard.writeText(params.srcURL),
        },
        { type: "separator" },
      );
    }

    if (params.isEditable) {
      items.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll" },
      );
    } else if (params.selectionText.trim()) {
      items.push({ role: "copy" });
    }

    // Drop a trailing separator so link-only menus end cleanly.
    while (items.length && items[items.length - 1].type === "separator")
      items.pop();
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: createdWindow });
  });

  // Show a themed recovery page instead of Chromium's network error.
  createdWindow.webContents.on(
    "did-fail-load",
    (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame) return;
      // A superseded navigation aborts as a matter of course, so ERR_ABORTED is
      // not a failure to report. It must not call off the stall guard either: an
      // abort that commits nothing is the empty window this guards against.
      if (code === -3 /* ERR_ABORTED */) return;
      showStatusPage(createdWindow);
    },
  );

  // Belt-and-braces: if the renderer ever dies, come back instead of showing
  // a dead window.
  createdWindow.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit") return;
    openHome(createdWindow);
  });

  if (initialURL && inActiveWindow(initialURL, createdWindow))
    loadApp(initialURL, createdWindow);
  else openHome(createdWindow);
  return createdWindow;
}

async function refreshAccountLabel(accountID, webContents) {
  try {
    const name = await webContents.executeJavaScript(
      "fetch('/api/settings/general', { credentials: 'include' }).then(r => r.ok ? r.json() : null).then(v => v && v.organizationName)",
      true,
    );
    if (typeof name !== "string" || !name.trim()) return;
    const stored = readStoredAccounts();
    const account = stored.accounts.find(
      (candidate) => candidate.id === accountID,
    );
    if (!account || account.label === name.trim()) return;
    account.label = name.trim();
    if (writeStoredAccounts(stored)) buildAppMenu();
  } catch {}
}

function syncBackgroundAccountWindows() {
  if (!appReady || quitting) return;
  const stored = readStoredAccounts();
  const visibleAccountIDs = new Set(
    [...appWindows]
      .map((target) => windowData.get(target)?.accountId)
      .filter(Boolean),
  );
  const inactive = stored.accounts.filter(
    (account) => !visibleAccountIDs.has(account.id),
  );
  const inactiveIDs = new Set(inactive.map((account) => account.id));
  for (const [id, accountWindow] of backgroundAccountWindows) {
    if (!inactiveIDs.has(id) || accountWindow.isDestroyed()) {
      if (!accountWindow.isDestroyed()) accountWindow.destroy();
      backgroundAccountWindows.delete(id);
    }
  }
  for (const account of inactive) {
    if (backgroundAccountWindows.has(account.id)) continue;
    const accountWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    accountWindow.webContents.setAudioMuted(true);
    const accountOrigin = new URL(account.url).origin;
    accountWindow.webContents.on("will-navigate", (event, url) => {
      try {
        if (new URL(url).origin !== accountOrigin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    accountWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    accountWindow.on("closed", () =>
      backgroundAccountWindows.delete(account.id),
    );
    accountWindow.webContents.on("did-finish-load", () => {
      refreshAccountLabel(account.id, accountWindow.webContents);
    });
    backgroundAccountWindows.set(account.id, accountWindow);
    accountWindow.loadURL(account.lastUrl || account.url).catch(() => {});
  }
}

function switchAccount(id, targetURL = null, target = activeWindow()) {
  if (!target || target.isDestroyed()) return;
  const stored = readStoredAccounts();
  const account = stored.accounts.find((candidate) => candidate.id === id);
  const current = accountForWindow(target, stored);
  if (!account || account.id === current?.id) return;

  // Keep each organization at its exact in-app URL. Loading the account root
  // delegated this to the web app's generic cold-start fallback, which could
  // only recover one session id and often selected the workspace's first tab.
  // Each visible window owns its account, so switching one must not navigate
  // any of the others.
  if (current) {
    const currentUrl = resumableAccountUrl(
      current.url,
      target.webContents.getURL(),
    );
    if (currentUrl) current.lastUrl = currentUrl;
  }
  const destination =
    resumableAccountUrl(account.url, targetURL) ||
    account.lastUrl ||
    account.url;
  account.lastUrl = destination;
  stored.activeId = account.id;
  if (!writeStoredAccounts(stored)) return;
  const data = windowData.get(target);
  if (data) data.accountId = account.id;
  refreshAccountOrigins();
  syncBackgroundAccountWindows();
  buildAppMenu();
  loadApp(destination, showWindow(target));
}

// What a window opens on: the app once there is a server to open, and the
// question itself until then.
function openHome(target = activeWindow()) {
  const accountURL = accountUrlForWindow(target);
  if (accountURL) loadApp(accountURL, target);
  else showSetup("app", target);
}

function organizationAccountMenuItems(stored = readStoredAccounts()) {
  const selectedID = accountForWindow(activeWindow(), stored)?.id;
  return stored.accounts.map((account, index) => ({
    label: `${account.label}${badgeByOrigin.get(new URL(account.url).origin) ? ` (${badgeByOrigin.get(new URL(account.url).origin)})` : ""}`,
    type: "radio",
    checked: account.id === selectedID,
    accelerator: index < 9 ? `CommandOrControl+Shift+${index + 1}` : undefined,
    click: () => switchAccount(account.id),
  }));
}

// Electron's default menu, plus "Check for Updates…" in the app menu — the
// standard roles keep all the stock items and shortcuts (edit, view, window).
function buildAppMenu() {
  if (process.platform !== "darwin") return;
  const organizationItems = organizationAccountMenuItems();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { label: "Check for Updates…", click: checkForUpdatesFromMenu },
          { type: "separator" },
          {
            label: "Organizations",
            submenu: [
              ...organizationItems,
              { type: "separator" },
              {
                label: "Add organization…",
                click: () => {
                  const target = showWindow();
                  showSetup("app", target, true);
                },
              },
              {
                label: "Edit current server…",
                click: () => {
                  const target = showWindow();
                  showSetup("app", target);
                },
              },
            ],
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "File",
        submenu: [
          {
            label: "New Window",
            accelerator: "CommandOrControl+N",
            click: () =>
              createWindow(null, accountForWindow(activeWindow())?.id || null),
          },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

app.whenReady().then(async () => {
  // `electron .` is not a packaged .app, so macOS otherwise shows Electron's
  // default Dock icon. Packaged builds get their signed bundle icon from
  // electron-builder; only the development runtime needs this explicit PNG.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, "../build/icon-512.png"));
  }

  // Which server, before anything that depends on it: the service-worker
  // block, the origins allowed to stay in this window and the update feed all
  // hang off the answer. Clearing a registration an older build left behind is
  // unconditional, since it belongs to whatever origin wrote it.
  adoptDefaultForExistingProfile();
  const chosen = RUN_URL || readStoredServer();
  if (chosen) setServer(chosen);
  await session.defaultSession
    .clearStorageData({ storages: ["serviceworkers", "cachestorage"] })
    .catch(() => {});

  // Remote content gets browser-level permissions only. Dictation (the
  // composer's mic button) arrives here as a "media" request and is handed to
  // macOS; everything else outside the allowlist is refused.
  session.defaultSession.setPermissionRequestHandler(
    async (wc, permission, callback, details) => {
      const allowed = [
        "notifications",
        "clipboard-sanitized-write",
        "fullscreen",
      ];
      if (!inWindow(wc.getURL())) return callback(false);
      if (permission === "media") {
        // Audio only. A request that also wants the camera isn't dictation.
        if (details?.mediaTypes?.includes("video")) return callback(false);
        return callback(await micAccessAllowed());
      }
      callback(allowed.includes(permission));
    },
  );

  ipcMain.on("os1:set-badge", (e, count) => {
    const source = e.senderFrame?.url ?? "";
    if (!inWindow(source)) return;
    let origin;
    try {
      origin = new URL(source).origin;
    } catch {
      return;
    }
    const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (next) badgeByOrigin.set(origin, next);
    else badgeByOrigin.delete(origin);
    const total = [...badgeByOrigin.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    app.setBadgeCount(total);
    buildAppMenu();
  });

  // The web app asks for this from a notification click handler, where its own
  // window.focus() cannot raise a background app.
  ipcMain.on("os1:focus-window", (e) => {
    const source = e.senderFrame?.url ?? "";
    if (!inWindow(source)) return;
    let origin;
    try {
      origin = new URL(source).origin;
    } catch {
      return;
    }
    const stored = readStoredAccounts();
    const account = stored.accounts.find(
      (candidate) => new URL(candidate.url).origin === origin,
    );
    const target = eventWindow(e) || activeWindow();
    if (account && account.id !== accountForWindow(target, stored)?.id)
      switchAccount(account.id, source, target);
    else showWindow(target);
  });

  const fromActiveOrganizationPicker = (e) => {
    const source = e.senderFrame?.url ?? "";
    const target = eventWindow(e);
    return !!target && inActiveWindow(source, target);
  };
  ipcMain.handle("os1:organizations-list", (e) => {
    if (!fromActiveOrganizationPicker(e)) return null;
    const stored = readStoredAccounts();
    return {
      activeId: accountForWindow(eventWindow(e), stored)?.id || stored.activeId,
      accounts: stored.accounts.map((account, index) => ({
        id: account.id,
        label: account.label,
        unread: badgeByOrigin.get(new URL(account.url).origin) || 0,
        shortcut: index < 9 ? index + 1 : null,
      })),
    };
  });
  ipcMain.on("os1:organizations-switch", (e, id) => {
    if (fromActiveOrganizationPicker(e) && typeof id === "string") {
      switchAccount(id, null, eventWindow(e));
    }
  });
  ipcMain.handle("os1:organizations-add", async (e, raw, check = true) => {
    if (!fromActiveOrganizationPicker(e)) return { ok: false };
    const normalized = normalizeServerUrl(raw);
    const resolved = check
      ? await resolveServer(raw)
      : { ok: !!normalized, url: normalized };
    if (!resolved.ok || !resolved.url) {
      return {
        ok: false,
        error: resolved.error || "Couldn't reach that Open Session server.",
        canAddAnyway: !!resolved.url,
        url: resolved.url,
      };
    }
    const stored = readStoredAccounts();
    if (stored.accounts.some((account) => account.url === resolved.url)) {
      return { ok: false, error: "That organization is already added." };
    }
    const account = {
      id: crypto.randomUUID(),
      label: new URL(resolved.url).host,
      url: resolved.url,
    };
    stored.accounts.push(account);
    if (!writeStoredAccounts(stored)) {
      return { ok: false, error: "Couldn't save that organization." };
    }
    refreshAccountOrigins();
    // Let invoke resolve before navigation destroys its renderer, then activate
    // the new account through the normal switch path.
    const target = eventWindow(e);
    setImmediate(() => switchAccount(account.id, null, target));
    return { ok: true };
  });
  ipcMain.on("os1:organizations-manage", (e) => {
    if (!fromActiveOrganizationPicker(e)) return;
    showSetup("app", eventWindow(e));
  });

  ipcMain.handle("os1:dictation-start", (e, id, sampleRate, language) => {
    if (!inWindow(e.senderFrame?.url ?? "")) return { ok: false };
    const sender = e.sender;
    return nativeDictation.start(id, Number(sampleRate), language, (text) => {
      if (sender.isDestroyed() || !inWindow(sender.getURL())) return;
      sender.send("os1:dictation-text", { id, text });
    });
  });
  ipcMain.on("os1:dictation-audio", (e, id, samples) => {
    if (!inWindow(e.senderFrame?.url ?? "")) return;
    nativeDictation.push(id, samples);
  });
  ipcMain.handle("os1:dictation-finish", (e, id) => {
    if (!inWindow(e.senderFrame?.url ?? "")) return { text: "" };
    return nativeDictation.finish(id);
  });
  ipcMain.on("os1:dictation-cancel", (e, id) => {
    if (!inWindow(e.senderFrame?.url ?? "")) return;
    nativeDictation.cancel(id);
  });

  ipcMain.handle("os1:update-state", (e) =>
    inWindow(e.senderFrame?.url ?? "")
      ? updateState
      : { state: "idle", version: null },
  );
  ipcMain.on("os1:update-install", (e) => {
    if (!inWindow(e.senderFrame?.url ?? "")) return;
    if (updateState.state !== "downloaded") return;
    // quitAndInstall closes every window; flip `quitting` first so the last
    // window's close-to-hide behavior does not cancel the relaunch.
    quitting = true;
    autoUpdater.quitAndInstall();
  });

  // The shell's own file:// pages are the only callers allowed here. The app
  // this window loads shares their preload, and a server must not be able to
  // repoint the shell at another one.
  const fromShellPage = (e) => (e.senderFrame?.url ?? "").startsWith("file://");

  ipcMain.on("os1:server-open", (e) => {
    if (fromShellPage(e)) showSetup("status", eventWindow(e));
  });
  ipcMain.on("os1:server-cancel", (e) => {
    if (!fromShellPage(e)) return;
    const target = eventWindow(e);
    const accountURL = accountUrlForWindow(target);
    if (!accountURL) return;
    const data = target && windowData.get(target);
    if (data?.setupReturnDestination === "status") showStatusPage(target);
    else loadApp(accountURL, target);
  });
  ipcMain.handle("os1:server-probe", async (e, raw) => {
    if (!fromShellPage(e)) return { ok: false };
    return resolveServer(raw);
  });
  ipcMain.handle("os1:server-save", (e, raw) => {
    if (!fromShellPage(e)) return { ok: false };
    const target = eventWindow(e);
    const data = target && windowData.get(target);
    const url = normalizeServerUrl(raw);
    if (!url)
      return { ok: false, error: "That doesn't look like a server address." };
    const previousAccount = accountForWindow(target);
    if (!writeStoredServer(url, data?.addingAccount, previousAccount?.id)) {
      return { ok: false, error: "Couldn't save that address." };
    }
    // A change reaches a running app by restarting it. The service-worker
    // block, the update feed, the origins this window keeps and the page
    // already loaded were all wired to the old address, and one restart is
    // steadier than four things kept in step. A first run has none of that
    // behind it yet.
    if (
      !data?.addingAccount &&
      previousAccount &&
      url !== previousAccount.url
    ) {
      quitting = true;
      app.relaunch();
      app.quit();
      return { ok: true };
    }
    setServer(url);
    const stored = readStoredAccounts();
    const selected = stored.accounts.find(
      (account) => account.id === stored.activeId,
    );
    if (data) data.accountId = selected?.id || null;
    initAutoUpdate();
    if (!flushPendingDeepLink()) openHome(target);
    return { ok: true };
  });

  buildAppMenu();

  appReady = true;
  createWindow(activeAccountResumeUrl());
  syncBackgroundAccountWindows();

  flushPendingDeepLink();

  initAutoUpdate();

  app.on("activate", () => showWindow());

  // Waking with the network still down is how the shell lands on the status
  // page in the first place, and that page can only retry while it is the page
  // on screen. A loaded app reconnects on its own and would lose drafts and
  // scroll position on a reload, so only the status page is retried here.
  powerMonitor.on("resume", () => {
    for (const appWindow of appWindows) {
      // Named rather than any file:// page: the setup page is someone typing.
      if (appWindow.webContents.getURL().includes("offline.html")) {
        const accountURL = accountUrlForWindow(appWindow);
        if (accountURL) loadApp(accountURL, appWindow);
      }
    }
  });
});

app.on("open-url", (e, url) => {
  e.preventDefault();
  openDeepLink(url);
});

// Universal links for the configured instance arrive here
// once the associated-domains entitlement + AASA are in place — see README.
app.on("continue-activity", (e, _type, _userInfo, details) => {
  if (details?.webpageURL) {
    e.preventDefault();
    openDeepLink(details.webpageURL);
  }
});

app.on("before-quit", () => {
  rememberWindowAccountUrl(activeWindow());
  quitting = true;
  nativeDictation.cancel();
  saveWindowState();
});

app.on("window-all-closed", () => {
  // macOS convention: stay in the dock until Cmd+Q.
});
