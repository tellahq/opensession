// Open Session side panel — the whole client lives here. Extension pages have
// full chrome.* API access, so the panel drives captures (screenshot, element
// pick via scripting injection) itself and talks to the Open Session server
// with plain fetch + Bearer token (device-flow sign-in, stored in
// chrome.storage.local). No frameworks, no build step.

const $ = (id) => document.getElementById(id);

// ── State ────────────────────────────────────────────────────────────────────

let defaultServer = "http://127.0.0.1:3850";
let accountStore = { accounts: [], activeId: "" };
let cfg = {
  id: "",
  label: "Organization",
  serverUrl: defaultServer,
  token: "",
  login: "",
  name: "",
  repositories: [],
  badge: 0,
};

function newAccount(serverUrl = "") {
  return {
    id: crypto.randomUUID(),
    label: "Organization",
    serverUrl,
    token: "",
    login: "",
    name: "",
    repositories: [],
    badge: 0,
  };
}

async function saveAccounts() {
  await chrome.storage.local.set({ accountStore });
}

function renderAccountPicker() {
  const picker = $("account-picker");
  picker.replaceChildren();
  for (const account of accountStore.accounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = `${account.label || "Organization"}${account.badge ? ` (${account.badge})` : ""}`;
    option.selected = account.id === accountStore.activeId;
    picker.appendChild(option);
  }
  $("in-account-label").value = cfg.label || "";
  $("in-server").value = cfg.serverUrl;
  $("btn-remove-account").disabled = accountStore.accounts.length === 1;
}

async function activateAccount(id, { keepView = false } = {}) {
  const account = accountStore.accounts.find(
    (candidate) => candidate.id === id,
  );
  if (!account || account.id === accountStore.activeId) return;
  deviceFlow = null;
  accountStore.activeId = account.id;
  account.badge = 0;
  cfg = account;
  await saveAccounts();
  renderAccountPicker();
  setAuthedUi(!!cfg.token);
  detail = { id: null, title: "", entryCount: 0, metaTick: 0 };
  if (!keepView) showView(cfg.token ? "new" : "settings");
  if (cfg.token) await loadComposerData();
}

// Captured context for the composer.
const ctx = {
  page: null, // { url, title }
  // True when page came from the right-click capture — stops the async
  // active-tab refresh from clobbering it (the panel itself is the active
  // "tab" in some flows, which would null the chip right after seeding).
  pagePinned: false,
  selection: "",
  screenshot: null, // dataUrl
  element: null, // { info, react, shot }
};

let view = "new";
let pollTimer = null;
let detail = { id: null, title: "", entryCount: 0, metaTick: 0 };
const INTENT_PREFIX = "opensession-intent:v3:";

async function intentDigest(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function durableIntent(name, identity) {
  if (!cfg.login) throw new Error("Sign in before sending durable work.");
  const scope = `${cfg.serverUrl.replace(/\/+$/, "").toLowerCase()}|${cfg.login.toLowerCase()}`;
  const [scopeHash, identityHash] = await Promise.all([
    intentDigest(scope),
    intentDigest(identity),
  ]);
  const key = `${INTENT_PREFIX}${scopeHash}:${name}:${identityHash}`;
  const stored = (await chrome.storage.local.get(key))[key];
  if (stored?.version === 3 && typeof stored.id === "string")
    return { key, id: stored.id };
  const id = crypto.randomUUID();
  await chrome.storage.local.set({
    [key]: { version: 3, id, createdAt: Date.now() },
  });
  const verified = (await chrome.storage.local.get(key))[key];
  if (verified?.id !== id)
    throw new Error("Could not save this request for retry.");
  return { key, id };
}

async function clearDurableIntent(intent) {
  const stored = (await chrome.storage.local.get(intent.key))[intent.key];
  if (stored?.version !== 3 || stored.id !== intent.id) return;
  await chrome.storage.local.remove(intent.key);
}

// ── API ──────────────────────────────────────────────────────────────────────

function apiUrl(path) {
  return cfg.serverUrl.replace(/\/+$/, "") + "/api" + path;
}

async function api(path, opts = {}) {
  const res = await fetch(apiUrl(path), {
    ...opts,
    credentials: "omit",
    headers: {
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    setAuthedUi(false);
    throw new Error("Not signed in. Open settings and sign in.");
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const b = await res.json();
      if (b?.error) msg = b.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

async function refreshAccountRepoOwners() {
  await Promise.all(
    accountStore.accounts.map(async (account) => {
      if (!account.token || !account.serverUrl) return;
      try {
        const root = account.serverUrl.replace(/\/+$/, "");
        const headers = { Authorization: `Bearer ${account.token}` };
        const [reposResponse, organizationResponse] = await Promise.all([
          fetch(`${root}/api/repos`, { credentials: "omit", headers }),
          fetch(`${root}/api/settings/general`, {
            credentials: "omit",
            headers,
          }),
        ]);
        if (reposResponse.ok) {
          const repos = await reposResponse.json();
          account.repositories = (repos.repos || []).map((repo) => ({
            id: repo.id,
            ghRepo: repo.ghRepo || repo.id,
          }));
        }
        if (organizationResponse.ok) {
          const organization = await organizationResponse.json();
          if (organization?.organizationName)
            account.label = organization.organizationName;
        }
      } catch {}
    }),
  );
  await saveAccounts();
  renderAccountPicker();
  guessRepo();
}

// ── Views ────────────────────────────────────────────────────────────────────

function showView(next) {
  view = next;
  for (const v of ["new", "sessions", "detail", "settings"]) {
    $(`view-${v}`).hidden = v !== next;
  }
  $("tab-new").classList.toggle("active", next === "new");
  $("tab-sessions").classList.toggle(
    "active",
    next === "sessions" || next === "detail",
  );
  clearInterval(pollTimer);
  pollTimer = null;
  if (next === "sessions") {
    loadSessions();
    pollTimer = setInterval(loadSessions, 5000);
  } else if (next === "detail") {
    loadTranscript(true);
    pollTimer = setInterval(loadTranscript, 2500);
  } else if (next === "new") {
    refreshPageChip();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function relTime(v) {
  const t = new Date(v).getTime();
  if (!t) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function toast(elId, msg, isErr = false) {
  const n = $(elId);
  n.textContent = msg;
  n.classList.toggle("err", isErr);
}

// ── Composer: context chips ──────────────────────────────────────────────────

function renderChips() {
  const box = $("ctx-chips");
  box.textContent = "";
  const chip = (label, title, onRemove, img) => {
    const c = el("span", "chip");
    if (img) {
      const i = document.createElement("img");
      i.src = img;
      c.append(i);
    }
    const t = el("span", "t", label);
    if (title) t.title = title;
    c.append(t);
    if (onRemove) {
      const x = el("button", "x", "×");
      x.addEventListener("click", onRemove);
      c.append(x);
    }
    box.append(c);
  };
  if (ctx.page) {
    chip(ctx.page.title || ctx.page.url, ctx.page.url, () => {
      ctx.page = null;
      ctx.pagePinned = false;
      renderChips();
    });
  }
  if (ctx.selection) {
    chip(
      `“${ctx.selection.slice(0, 40)}${ctx.selection.length > 40 ? "…" : ""}”`,
      ctx.selection,
      () => {
        ctx.selection = "";
        renderChips();
      },
    );
  }
  if (ctx.screenshot) {
    chip(
      "Screenshot",
      null,
      () => {
        ctx.screenshot = null;
        renderChips();
      },
      ctx.screenshot,
    );
  }
  if (ctx.element) {
    const reactName = ctx.element.react?.components?.[0];
    chip(
      reactName ? `<${reactName.replace(/ \(.*/, "")}>` : ctx.element.info.dom,
      ctx.element.info.domPath,
      () => {
        ctx.element = null;
        renderChips();
      },
      ctx.element.shot || undefined,
    );
  }
}

async function refreshPageChip() {
  const tab = await activeTab();
  if (ctx.pagePinned) return;
  if (tab?.url && /^https?:/.test(tab.url)) {
    ctx.page = { url: tab.url, title: tab.title || "" };
  } else {
    ctx.page = null;
  }
  renderChips();
  guessRepo();
}

async function guessRepo() {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/i.exec(
    ctx.page?.url || "",
  );
  if (!match) return;
  const owner = match[1].toLowerCase();
  const repo = match[2].replace(/\.git$/i, "").toLowerCase();
  const ghRepo = `${owner}/${repo}`;
  const matchedAccount = accountStore.accounts.find((account) =>
    (account.repositories || []).some(
      (candidate) => String(candidate.ghRepo || "").toLowerCase() === ghRepo,
    ),
  );
  if (matchedAccount && matchedAccount.id !== accountStore.activeId) {
    await activateAccount(matchedAccount.id, { keepView: true });
  }
  const picker = $("sel-repo");
  const configuredRepo = (cfg.repositories || []).find(
    (candidate) => String(candidate.ghRepo || "").toLowerCase() === ghRepo,
  );
  const option = configuredRepo
    ? [...picker.options].find(
        (candidate) => candidate.value === configuredRepo.id,
      )
    : [...picker.options].find(
        (candidate) => candidate.value.toLowerCase() === ghRepo,
      );
  if (option) picker.value = option.value;
}

// ── Composer: captures ───────────────────────────────────────────────────────

async function captureScreenshot() {
  const tab = await activeTab();
  if (!tab) return;
  try {
    ctx.screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    renderChips();
    toast("new-status", "");
  } catch (e) {
    toast("new-status", `Screenshot failed: ${e.message}`, true);
  }
}

// Runs in the page's MAIN world after the picker tagged the chosen element —
// walks the React fiber tree upward from the tagged node, collecting the
// component stack (with source file:line when the build carries _debugSource,
// i.e. dev builds) and a shallow, primitives-only view of the nearest
// component's props. Must stay self-contained: it is serialized for injection.
function readPickedReactInfo() {
  const target = document.querySelector("[data-os1-picked]");
  if (!target) return null;
  target.removeAttribute("data-os1-picked");
  let node = target;
  let fiber = null;
  while (node && !fiber) {
    for (const k of Object.keys(node)) {
      if (k.startsWith("__reactFiber$")) {
        fiber = node[k];
        break;
      }
    }
    node = node.parentElement;
  }
  if (!fiber) return { react: false };
  const components = [];
  let props = null;
  let f = fiber;
  let hops = 0;
  while (f && hops < 80 && components.length < 12) {
    const t = f.type;
    let name = null;
    if (typeof t === "function") name = t.displayName || t.name || null;
    else if (t && typeof t === "object") {
      const inner = t.type || t.render;
      name =
        t.displayName || (inner && (inner.displayName || inner.name)) || null;
    }
    if (name) {
      let src = "";
      const d = f._debugSource;
      if (d && d.fileName) {
        src = d.fileName.replace(/^.*?\/(src|app|apps|packages)\//, "$1/");
        if (d.lineNumber) src += ":" + d.lineNumber;
      }
      components.push(src ? `${name} (${src})` : name);
      if (!props && f.memoizedProps && typeof f.memoizedProps === "object") {
        props = {};
        let count = 0;
        for (const [k, v] of Object.entries(f.memoizedProps)) {
          if (k === "children" || count >= 12) continue;
          const tv = typeof v;
          if (tv === "string")
            props[k] = v.length > 60 ? v.slice(0, 60) + "…" : v;
          else if (tv === "number" || tv === "boolean" || v === null)
            props[k] = v;
          else props[k] = tv === "function" ? "ƒ" : tv;
          count++;
        }
      }
    }
    f = f.return;
    hops++;
  }
  return { react: true, components, props };
}

async function cropDataUrl(dataUrl, rect) {
  try {
    const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
    // captureVisibleTab returns device pixels; rect is viewport CSS px.
    const s = rect.dpr || 1;
    const pad = 8 * s;
    const sx = Math.max(0, rect.x * s - pad);
    const sy = Math.max(0, rect.y * s - pad);
    const sw = Math.min(img.width - sx, rect.w * s + pad * 2);
    const sh = Math.min(img.height - sy, rect.h * s + pad * 2);
    if (sw <= 4 || sh <= 4) return null;
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

async function pickElement() {
  const tab = await activeTab();
  if (!tab?.id) return;
  const btn = $("btn-pick");
  btn.classList.add("busy");
  btn.textContent = "Click an element on the page…";
  try {
    const resultP = new Promise((resolve) => {
      const listener = (msg, sender) => {
        if (msg?.type === "os1PickerResult" && sender.tab?.id === tab.id) {
          chrome.runtime.onMessage.removeListener(listener);
          resolve(msg);
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(null);
      }, 120000);
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["picker.js"],
    });
    const msg = await resultP;
    if (!msg?.ok) return; // cancelled or timed out
    let react = null;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: readPickedReactInfo,
      });
      react = res?.result || null;
    } catch {}
    let shot = null;
    try {
      const full = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      shot = await cropDataUrl(full, msg.info.rect);
    } catch {}
    ctx.element = { info: msg.info, react, shot };
    renderChips();
    toast("new-status", "");
  } catch (e) {
    toast("new-status", `Can't inspect this page (${e.message})`, true);
  } finally {
    btn.classList.remove("busy");
    btn.textContent = "⊙ Pick element";
  }
}

// ── Composer: start session ──────────────────────────────────────────────────

function buildPrompt(text) {
  const lines = [];
  if (ctx.page) {
    lines.push(`Page: ${ctx.page.title}`.trim());
    lines.push(`URL: ${ctx.page.url}`);
  }
  if (ctx.selection) lines.push(`Selected text: """${ctx.selection}"""`);
  if (ctx.element) {
    const i = ctx.element.info;
    lines.push(`Element: ${i.dom}${i.aria ? ` (${i.aria})` : ""}`);
    lines.push(`  DOM path: ${i.domPath}`);
    if (i.text) lines.push(`  Text: "${i.text.slice(0, 120)}"`);
    const r = ctx.element.react;
    if (r?.react && r.components?.length) {
      lines.push(
        `  React components (innermost first): ${r.components.join(" ← ")}`,
      );
      if (r.props && Object.keys(r.props).length) {
        lines.push(`  Props of nearest component: ${JSON.stringify(r.props)}`);
      }
    } else if (r && r.react === false) {
      lines.push("  (no React fiber found on this element)");
    }
  }
  if (!lines.length) return text;
  return `${text}\n\n--- Context captured from Chrome (Open Session extension) ---\n${lines.join("\n")}`;
}

async function startSession() {
  const text = $("prompt").value.trim();
  if (!text) {
    toast("new-status", "Write a prompt first.", true);
    return;
  }
  const btn = $("btn-start");
  btn.disabled = true;
  toast("new-status", "Starting session…");
  try {
    const images = [];
    if (ctx.screenshot) images.push(ctx.screenshot);
    if (ctx.element?.shot) images.push(ctx.element.shot);
    const body = {
      prompt: buildPrompt(text),
      repo: $("sel-repo").value || undefined,
      mode: $("sel-mode").value,
      ...($("sel-model").value ? { model: $("sel-model").value } : {}),
      ...(images.length ? { images } : {}),
    };
    const createIntent = await durableIntent(
      "create",
      JSON.stringify({ server: cfg.serverUrl, body }),
    );
    const { id } = await api("/sessions", {
      method: "POST",
      body: JSON.stringify({ ...body, requestId: createIntent.id }),
    });
    await clearDurableIntent(createIntent);
    $("prompt").value = "";
    ctx.screenshot = null;
    ctx.element = null;
    ctx.selection = "";
    renderChips();
    toast("new-status", "");
    openDetail(id, text.slice(0, 60));
  } catch (e) {
    toast("new-status", `Failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Sessions list ────────────────────────────────────────────────────────────

async function loadSessions() {
  const accountID = cfg.id;
  try {
    const sessions = await api("/sessions");
    if (cfg.id !== accountID) return;
    const list = $("sessions-list");
    list.textContent = "";
    const rows = sessions
      .filter((s) => !s.archived)
      .sort(
        (a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0),
      )
      .slice(0, 40);
    if (!rows.length) list.append(el("div", "status", "No sessions."));
    for (const s of rows) {
      const row = el("div", "sess-row");
      const dot = el("span", "dot");
      if (s.waitingForInput) dot.classList.add("waiting");
      else if (s.isRunning) dot.classList.add("running");
      const main = el("div", "sess-main");
      main.append(el("div", "sess-title", s.title || s.id));
      const bits = [
        s.repo,
        s.mode === "code" ? s.branch : s.mode,
        s.waitingForInput ? "needs input" : s.isRunning ? "running" : "",
        s.queuedCount ? `${s.queuedCount} queued` : "",
        relTime(s.lastActivity),
      ].filter(Boolean);
      main.append(el("div", "sess-sub", bits.join(" · ")));
      row.append(dot, main);
      row.addEventListener("click", () => openDetail(s.id, s.title || s.id));
      list.append(row);
    }
  } catch (e) {
    $("sessions-list").textContent = "";
    $("sessions-list").append(
      el("div", "status err", `Failed to load: ${e.message}`),
    );
  }
}

// ── Session detail ───────────────────────────────────────────────────────────

function openDetail(id, title) {
  detail = { id, title, entryCount: 0, metaTick: 0 };
  $("detail-title").textContent = title || id;
  $("detail-open").href = cfg.serverUrl.replace(/\/+$/, "") + "/session/" + id;
  $("transcript").textContent = "";
  $("detail-status").textContent = "";
  showView("detail");
}

function renderEntry(e) {
  const type = e.type;
  if (type === "tool_use") {
    return el("div", "msg tool", `⚙ ${e.toolName || "tool"}`);
  }
  if (type !== "user" && type !== "assistant") return null;
  const content = typeof e.content === "string" ? e.content : "";
  // Large pastes ride beside the message as `pastedTexts`; name them rather
  // than print them, the web UI is the place for full reading.
  const pasted = Array.isArray(e.pastedTexts) ? e.pastedTexts : [];
  if (!content.trim() && !pasted.length) return null;
  const wrap = el("div", `msg ${type}`);
  wrap.append(el("div", "who", type === "user" ? e.user || "you" : "agent"));
  // Clamp giant messages.
  if (content.trim())
    wrap.append(
      el(
        "div",
        "body",
        content.length > 4000 ? content.slice(0, 4000) + "\n…" : content,
      ),
    );
  for (const text of pasted) {
    const lines = String(text).split(/\r\n|\r|\n/).length;
    wrap.append(
      el(
        "div",
        "body",
        `[Pasted text · ${lines} line${lines === 1 ? "" : "s"}]`,
      ),
    );
  }
  return wrap;
}

async function loadTranscript(initial = false) {
  if (!detail.id) return;
  const accountID = cfg.id;
  try {
    const entries = await api(
      `/sessions/${encodeURIComponent(detail.id)}/transcript`,
    );
    if (cfg.id !== accountID) return;
    if (Array.isArray(entries) && entries.length !== detail.entryCount) {
      detail.entryCount = entries.length;
      const box = $("transcript");
      const nearBottom =
        initial || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      box.textContent = "";
      for (const e of entries.slice(-120)) {
        const n = renderEntry(e);
        if (n) box.append(n);
      }
      if (nearBottom) box.scrollTop = box.scrollHeight;
    }
    // Session meta (state/queue) every other tick — it's a full list fetch.
    if (detail.metaTick++ % 2 === 0) {
      // The side panel only ever shows live sessions, so it asks the server to
      // leave archived ones out — ~46% of the payload on a busy instance. The
      // filter below stays for older servers, which ignore the parameter.
      const sessions = await api("/sessions?archived=exclude");
      if (cfg.id !== accountID) return;
      const s = sessions.find((x) => x.id === detail.id);
      if (s) {
        $("detail-title").textContent = s.title || detail.title || s.id;
        const bits = [
          s.waitingForInput
            ? "⚠ waiting for input · answer in the web UI"
            : s.isRunning
              ? "● running"
              : "idle",
          s.queuedCount ? `${s.queuedCount} queued` : "",
          s.repo,
          s.mode === "code" ? s.branch : s.mode,
        ].filter(Boolean);
        toast("detail-status", bits.join(" · "), false);
      }
    }
  } catch (e) {
    if (initial) toast("detail-status", `Failed to load: ${e.message}`, true);
  }
}

async function sendFollowup() {
  const ta = $("followup-text");
  const content = ta.value.trim();
  if (!content || !detail.id) return;
  const btn = $("btn-send");
  btn.disabled = true;
  try {
    const followupIntent = await durableIntent(
      "followup",
      JSON.stringify({ server: cfg.serverUrl, sessionId: detail.id, content }),
    );
    const res = await api(`/sessions/${encodeURIComponent(detail.id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content, clientId: followupIntent.id }),
    });
    await clearDurableIntent(followupIntent);
    ta.value = "";
    toast(
      "detail-status",
      res.status === "steered"
        ? "Folded into the running turn"
        : res.status === "queued"
          ? "Queued behind the current run"
          : "Sent",
    );
    loadTranscript();
  } catch (e) {
    toast("detail-status", `Send failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Composer data (repos/models) ─────────────────────────────────────────────

async function loadComposerData() {
  const accountID = cfg.id;
  try {
    const [repos, models, organization] = await Promise.all([
      api("/repos"),
      api("/models"),
      api("/settings/general").catch(() => null),
    ]);
    if (cfg.id !== accountID) return;
    cfg.repositories = (repos.repos || []).map((repo) => ({
      id: repo.id,
      ghRepo: repo.ghRepo || repo.id,
    }));
    if (organization?.organizationName)
      cfg.label = organization.organizationName;
    await saveAccounts();
    renderAccountPicker();
    const rs = $("sel-repo");
    rs.textContent = "";
    for (const r of repos.repos || []) {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = r.label || r.id;
      rs.append(o);
    }
    rs.value =
      (repos.repos || []).find((repo) => repo.default)?.id ||
      rs.options[0]?.value ||
      "";
    const ms = $("sel-model");
    ms.textContent = "";
    const dflt = document.createElement("option");
    dflt.value = "";
    const dfltLabel = (models.models || []).find(
      (m) => m.id === models.default,
    );
    dflt.textContent = `Model: default${dfltLabel?.label ? ` (${dfltLabel.label})` : ""}`;
    ms.append(dflt);
    for (const m of models.models || []) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label || m.id;
      ms.append(o);
    }
    guessRepo();
  } catch {
    // Offline / not signed in — composer still usable once auth is fixed.
  }
}

// ── Settings & auth ──────────────────────────────────────────────────────────

function setAuthedUi(authed) {
  $("btn-signin").hidden = authed;
  $("btn-signout").hidden = !authed;
  $("auth-state").textContent = authed
    ? `Signed in as ${cfg.name || cfg.login} (@${cfg.login})`
    : "Not signed in.";
}

let deviceFlow = null;

async function startSignIn() {
  toast("auth-state", "Starting GitHub sign-in…");
  try {
    // Device flow needs no token; server must allow the chrome-extension
    // origin (web-auth.ts crossSiteViolation carve-out).
    const res = await fetch(apiUrl("/auth/device"), {
      method: "POST",
      credentials: "omit",
    });
    const flow = await res.json();
    if (!res.ok || flow.error) throw new Error(flow.error || `${res.status}`);
    deviceFlow = flow;
    $("device-flow").hidden = false;
    $("device-code").textContent = flow.userCode;
    $("btn-open-verify").onclick = () =>
      chrome.tabs.create({
        url: flow.verificationUri || "https://github.com/login/device",
      });
    toast("device-status", "Waiting for authorization…");
    pollDeviceFlow(flow.deviceCode);
  } catch (e) {
    toast("auth-state", `Sign-in failed: ${e.message}`, true);
  }
}

async function pollDeviceFlow(deviceCode) {
  if (deviceFlow?.deviceCode !== deviceCode) return; // superseded
  try {
    const res = await fetch(apiUrl("/auth/device/poll"), {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode, native: true }),
    });
    const out = await res.json();
    if (out.status === "ok" && out.token) {
      deviceFlow = null;
      $("device-flow").hidden = true;
      cfg.token = out.token;
      cfg.login = out.login;
      cfg.name = out.name || out.login;
      await saveAccounts();
      renderAccountPicker();
      setAuthedUi(true);
      loadComposerData();
      showView("new");
      return;
    }
    if (out.status === "error") {
      deviceFlow = null;
      $("device-flow").hidden = true;
      toast("auth-state", `Sign-in failed: ${out.error}`, true);
      return;
    }
    setTimeout(() => pollDeviceFlow(deviceCode), 3500);
  } catch {
    setTimeout(() => pollDeviceFlow(deviceCode), 6000);
  }
}

async function signOut() {
  try {
    await api("/auth/logout", { method: "POST" });
  } catch {}
  cfg.token = "";
  cfg.login = "";
  cfg.name = "";
  await saveAccounts();
  renderAccountPicker();
  setAuthedUi(false);
}

// ── Pending context from the right-click menu ────────────────────────────────

async function applyPendingContext() {
  const { pendingContext } = await chrome.storage.session.get("pendingContext");
  if (!pendingContext) return;
  await chrome.storage.session.remove("pendingContext");
  if (pendingContext.url) {
    ctx.page = { url: pendingContext.url, title: pendingContext.title || "" };
    ctx.pagePinned = true;
  }
  if (pendingContext.selection) ctx.selection = pendingContext.selection;
  renderChips();
  guessRepo();
  showView("new");
  $("prompt").focus();
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const deployment = await fetch(
      chrome.runtime.getURL("deployment.json"),
    ).then((res) => res.json());
    if (deployment?.defaultServer) defaultServer = deployment.defaultServer;
  } catch {}
  const stored = await chrome.storage.local.get(["accountStore", "cfg"]);
  if (stored.accountStore?.accounts?.length) {
    accountStore = stored.accountStore;
  } else {
    const migrated = { ...newAccount(defaultServer), ...(stored.cfg || {}) };
    if (!migrated.id) migrated.id = crypto.randomUUID();
    if (!migrated.label) migrated.label = "Organization";
    accountStore = { accounts: [migrated], activeId: migrated.id };
    await saveAccounts();
    await chrome.storage.local.remove("cfg");
  }
  cfg =
    accountStore.accounts.find(
      (account) => account.id === accountStore.activeId,
    ) || accountStore.accounts[0];
  accountStore.activeId = cfg.id;
  renderAccountPicker();

  $("tab-new").addEventListener("click", () => showView("new"));
  $("tab-sessions").addEventListener("click", () => showView("sessions"));
  $("btn-settings").addEventListener("click", () => showView("settings"));
  $("account-picker").addEventListener("change", (event) =>
    activateAccount(event.target.value),
  );
  $("in-account-label").addEventListener("change", async () => {
    cfg.label = $("in-account-label").value.trim() || "Organization";
    await saveAccounts();
    renderAccountPicker();
  });
  $("btn-add-account").addEventListener("click", async () => {
    deviceFlow = null;
    $("device-flow").hidden = true;
    const account = newAccount("");
    accountStore.accounts.push(account);
    accountStore.activeId = account.id;
    cfg = account;
    await saveAccounts();
    renderAccountPicker();
    setAuthedUi(false);
    showView("settings");
  });
  $("btn-remove-account").addEventListener("click", async () => {
    if (accountStore.accounts.length === 1) return;
    deviceFlow = null;
    $("device-flow").hidden = true;
    accountStore.accounts = accountStore.accounts.filter(
      (account) => account.id !== cfg.id,
    );
    cfg = accountStore.accounts[0];
    accountStore.activeId = cfg.id;
    await saveAccounts();
    renderAccountPicker();
    setAuthedUi(!!cfg.token);
    showView(cfg.token ? "new" : "settings");
    if (cfg.token) await loadComposerData();
  });
  $("btn-back").addEventListener("click", () => showView("sessions"));
  $("btn-shot").addEventListener("click", captureScreenshot);
  $("btn-pick").addEventListener("click", pickElement);
  $("btn-start").addEventListener("click", startSession);
  $("btn-send").addEventListener("click", sendFollowup);
  $("btn-signin").addEventListener("click", startSignIn);
  $("btn-signout").addEventListener("click", signOut);
  $("in-server").addEventListener("change", async () => {
    cfg.serverUrl = $("in-server").value.trim() || defaultServer;
    $("in-server").value = cfg.serverUrl;
    try {
      const origin = new URL(cfg.serverUrl).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        toast(
          "settings-status",
          "Permission to connect to this server was declined.",
          true,
        );
        return;
      }
    } catch {
      toast("settings-status", "Enter a valid http(s) server URL.", true);
      return;
    }
    await saveAccounts();
    renderAccountPicker();
  });
  $("prompt").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") startSession();
  });
  $("followup-text").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") sendFollowup();
  });

  // Keep the page chip in sync with the active tab while composing.
  chrome.tabs.onActivated.addListener(() => {
    if (view === "new") refreshPageChip();
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (view === "new" && tab.active && info.url) refreshPageChip();
  });
  // Context-menu capture while the panel is already open.
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.pendingContext?.newValue) applyPendingContext();
  });

  setAuthedUi(!!cfg.token);
  if (!cfg.token) {
    showView("settings");
  } else {
    showView("new");
    loadComposerData();
  }
  applyPendingContext();
  refreshAccountRepoOwners();
}

init();
