/*
 * Open Session service worker — Web Push + app-shell cache. Shows pushes as
 * notifications and focuses/opens the right session on tap; caches the SPA
 * shell so cold starts are instant and a dead/black-holed tailnet gets the
 * app's own reconnecting state instead of a white error page.
 *
 * Prefix-agnostic: the app serves at the bare domain root; registrations from
 * the historical /opensession/ + /backstage/ scopes may still exist on older
 * installs. All asset/navigation URLs derive from this registration's scope,
 * and pushed URLs are re-prefixed onto it — so a payload built with any
 * historical prefix opens correctly inside whichever install received it.
 */
const PREFIX = new URL(self.registration.scope).pathname.replace(/\/$/, "");

/** Rewrite a pushed app URL onto this registration's own prefix. */
function localUrl(url) {
  if (!url) return PREFIX + "/";
  return url
    .replace(/^\/opensession(\/|$)/, PREFIX + "$1")
    .replace(/^\/backstage(\/|$)/, PREFIX + "$1");
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // Best effort, never blocking: the worker's push and navigation duties do
  // not depend on these, so a failed fetch must not fail the install.
  event.waitUntil(
    caches
      .open(GATE_CACHE)
      .then((cache) =>
        Promise.all(
          GATE_PATHS.map((p) => cache.add(PREFIX + p).catch(() => {})),
        ),
      )
      .catch(() => {}),
  );
});
self.addEventListener("activate", (event) => event.waitUntil(activateWorker()));

async function activateWorker() {
  const keys = await caches.keys();
  const retired = keys.filter(
    (key) =>
      key.startsWith("os1-shell-") &&
      key !== HTML_CACHE &&
      key !== ASSET_CACHE &&
      key !== GATE_CACHE,
  );
  await Promise.all([
    self.clients.claim(),
    ...retired.map((key) => caches.delete(key)),
  ]);

  // A page that installed this migration is still running the bundle from the
  // v1 shell we just removed. Reload only those clients, once, so the user does
  // not need a second close/open cycle for v2 to become visible.
  if (!retired.includes("os1-shell-html-v1")) return;
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  await Promise.all(
    windows.map((client) => client.navigate(client.url).catch(() => {})),
  );
}

/* ── App-shell caching ────────────────────────────────────────────────────
 * Navigations are NETWORK-FIRST: freshness stays authoritative — an in-process
 * rebuild (frontend_updated) is picked up on the very next load exactly as
 * before, so the cache can never pin a stale build on a working connection.
 * The cached shell is served only when the network fails, or stalls past
 * NAV_STALL_MS (the "VPN is up but the tailnet is unreachable" white-screen
 * case). Bundle assets are content-hashed (App-<hash>.js, global-<hash>.css)
 * and served immutable, so those are CACHE-FIRST: a cached entry can never be
 * stale, a new build simply asks for new names.
 */
// v2 deliberately retires the pre-no-store shell. Keeping that v1 entry let
// an updated worker's stall fallback resurrect an app bundle from before live
// sessions were split from archived ones.
const HTML_CACHE = "os1-shell-html-v2";
const ASSET_CACHE = "os1-shell-assets-v1";
// One shell entry per prefix (both registrations share the origin's caches).
const SHELL_KEY = PREFIX + "/__app-shell__";
const NAV_STALL_MS = 5000;
// Hashed js/css at the root or a legacy prefix: <name>-<hash>.js|css. Never
// matches sw.js itself (no dash) or icons/splash (not js/css).
const ASSET_RE = /^\/(?:opensession\/|backstage\/)?[\w.]+-\w+\.(?:js|css)$/;
const API_RE = /^\/(?:opensession\/|backstage\/)?api\//;
// Server routes that answer a navigation with a REDIRECT rather than the app
// shell. The stall guard below must never fire on these: they can legitimately
// take longer than NAV_STALL_MS (a Plain triage boot runs 15-120s), and
// painting the shell over one strands the document at a URL the router has no
// route for — which the app then treats as "landed on home" and replaces with
// the viewer's last session. Let them go straight to the network and redirect.
const REDIRECT_RE = /^\/(?:opensession\/|backstage\/)?plain-triage\//;
// A build ships ~a dozen chunks; 80 keeps a few builds' worth before pruning.
const MAX_ASSETS = 80;

/* ── Gate-screen assets ───────────────────────────────────────────────────
 * The sign-in screens are the ones that render when the server is NOT
 * answering: a failed /api/auth/status is what puts "Couldn't check sign-in"
 * on screen, and the card's icon is a network fetch that just failed with it.
 * On a phone that left a broken-image glyph above the title, so the screen
 * reporting the outage looked broken itself. These few unhashed assets are
 * precached at install and served cache-first, which is what the app-shell
 * cache already promises for everything else on that screen.
 *
 * Their own cache rather than ASSET_CACHE: that one is pruned oldest-first,
 * and precached entries are by definition the oldest ones there.
 *
 * The same fixed light/dark artwork used by onboarding is small enough to
 * cache in full, so offline and reduced-motion visitors see the real surface.
 * v2 retires the old Silver Silk posters from the cache.
 */
const GATE_CACHE = "os1-shell-gate-v2";
const GATE_PATHS = [
  "/mac-app-icon.png",
  "/onboarding-bg.webp",
  "/onboarding-bg-dark.webp",
];
const GATE_RE =
  /^\/(?:opensession\/|backstage\/)?(?:mac-app-icon\.png|onboarding-bg(?:-dark)?\.webp)$/;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (
    req.mode === "navigate" &&
    !API_RE.test(url.pathname) &&
    !REDIRECT_RE.test(url.pathname)
  ) {
    event.respondWith(shellNavigate(req));
  } else if (ASSET_RE.test(url.pathname)) {
    event.respondWith(hashedAsset(req));
  } else if (GATE_RE.test(url.pathname)) {
    event.respondWith(gateAsset(req, event));
  }
});

// Cache-first with a background refresh: these names are unhashed, so a
// redrawn mark ships under the same URL and the next load picks it up.
async function gateAsset(req, event) {
  const cache = await caches.open(GATE_CACHE);
  // A controlled page can still use a historical root/prefix different from
  // this worker's scope. Keep one local key so all three URL shapes share the
  // copy installed above; ignore query revisions used by icon metadata too.
  const path = new URL(req.url).pathname.replace(
    /^\/(?:opensession|backstage)(?=\/|$)/,
    "",
  );
  const key = new URL(PREFIX + path, self.location.origin).href;
  const hit = await cache.match(key, {
    ignoreSearch: true,
    ignoreVary: true,
  });
  const refresh = fetch(req).then(async (res) => {
    if (res.ok) await cache.put(key, res.clone());
    return res;
  });
  if (!hit) return refresh;
  event.waitUntil(refresh.catch(() => {}));
  return hit;
}

async function shellNavigate(req) {
  const cache = await caches.open(HTML_CACHE);
  const cached = await cache.match(SHELL_KEY);
  // Bypass WebKit's HTTP cache. The worker's own shell cache is the only
  // intentional fallback; accepting a browser-cached 200 here can keep an
  // installed PWA on an old App-<hash>.js after a successful reload.
  const network = fetch(req, { cache: "no-store" }).then((res) => {
    // Tee only genuine SPA-shell responses into the cache; API/media
    // navigations (non-HTML) pass through untouched.
    const type = res.headers.get("content-type") || "";
    if (res.ok && type.includes("text/html")) cache.put(SHELL_KEY, res.clone());
    return res;
  });
  if (!cached) return network;
  return Promise.race([
    network.catch(() => cached),
    // Stall guard: a black-holed connection hangs for 60s+; after NAV_STALL_MS
    // paint the cached shell (the network fetch still completes above and
    // refreshes the cache for the next load).
    new Promise((r) => setTimeout(r, NAV_STALL_MS)).then(() => cached),
  ]);
}

async function hashedAsset(req) {
  const cache = await caches.open(ASSET_CACHE);
  // ignoreVary: asset responses carry `Vary: Accept-Encoding`, which would
  // otherwise fragment the cache on header differences that don't matter here.
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    trimAssets(cache).catch(() => {});
  }
  return res;
}

async function trimAssets(cache) {
  const keys = await cache.keys(); // insertion order — oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) {
    await cache.delete(k);
  }
}

// App-icon badge (iOS/macOS PWA dock + home screen): there's no read-state
// here in the worker, so the count mirrors the notifications still on screen.
// The open app overwrites it with the real unread count (App.tsx).
async function updateAppBadge(excludeTag) {
  if (!self.navigator.setAppBadge) return;
  try {
    let notifs = await self.registration.getNotifications();
    // A just-closed notification can still be listed for a beat — drop it.
    if (excludeTag) notifs = notifs.filter((n) => n.tag !== excludeTag);
    if (notifs.length > 0) await self.navigator.setAppBadge(notifs.length);
    else await self.navigator.clearAppBadge();
  } catch {}
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  const title = data.title || "Open Session";
  event.waitUntil(
    self.registration
      .showNotification(title, {
        body: data.body || "",
        tag: data.tag || undefined,
        icon: PREFIX + "/icon-192.png",
        badge: PREFIX + "/icon-192.png",
        data: { url: localUrl(data.url) },
      })
      .then(() => updateAppBadge()),
  );
});

/*
 * A tap has to do two things: bring the app forward, and land it on the
 * session the notification is about.
 *
 * The document is never reloaded to get there. `WindowClient.navigate()`
 * rejects outright on a client this worker does not control, and matchAll asks
 * for uncontrolled ones too, so that is an ordinary case rather than an edge
 * one. That rejection used to float unhandled, leaving `focus()` as the only
 * surviving effect: the app came forward on whatever page it was already
 * showing. The URL is posted to the page instead and its own router handles
 * it, which is also what makes the tap instant rather than a full SPA reload.
 * `navigate()` and `openWindow()` remain as fallbacks for a page too old or
 * too frozen to answer.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = localUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    Promise.all([updateAppBadge(event.notification.tag), openApp(url)]),
  );
});

// How long the page gets to acknowledge the routing message. It is a live
// page answering a postMessage, so this is generous; the cost of it being too
// short is a document navigation that did not need to happen.
const NAV_ACK_MS = 700;

async function openApp(url) {
  const wins = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  // Prefer the window the person is actually looking at: routing a background
  // window is a change nobody sees.
  const client =
    wins.find((w) => w.focused) ||
    wins.find((w) => w.visibilityState === "visible") ||
    wins[0];
  if (!client) return self.clients.openWindow(url);
  // Focus first. It needs the tap's transient activation, which an awaited
  // round trip to the page could outlive.
  if ("focus" in client) await client.focus().catch(() => {});
  if (await postNavigate(client, url)) return;
  if (client.navigate) {
    try {
      await client.navigate(url);
      return;
    } catch {}
  }
  return self.clients.openWindow(url);
}

// Ask a page to route itself, and wait for it to say it did. The ack is what
// keeps the fallbacks from navigating a page that already handled the tap.
function postNavigate(client, url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => finish(true);
      client.postMessage({ type: "os1-navigate", url }, [channel.port2]);
    } catch {
      finish(false);
    }
    setTimeout(() => finish(false), NAV_ACK_MS);
  });
}
