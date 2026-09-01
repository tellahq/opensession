// Per-user visibility for the sidebar's tools. The local copy keeps startup
// synchronous; the ui-prefs value makes the choice follow the person across
// devices and into the native app, which reads the same key and the same
// defaults (packages/clients/ios/OS1/SidebarTools.swift). Before that pref existed this was
// one browser-wide localStorage key, so a tool switched off at a desk was
// still on the phone.

import { getCurrentUser } from "../components/UserPicker";
import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { whenCurrentUserReady } from "./auth-ready";

// Feed leads. The tools below it are places you go to act on one kind of
// thing; Feed is what the team has actually been doing, which is the page you
// want in front of you when you have not decided what to work on yet.
export const SIDEBAR_TOOL_IDS = [
  "feed",
  "prs",
  "tasks",
  "plain",
  "catchup",
  "supporttinder",
  "reports",
  "analytics",
] as const;

export type SidebarToolId = (typeof SIDEBAR_TOOL_IDS)[number];

export const SIDEBAR_TOOL_LABELS: Record<SidebarToolId, string> = {
  feed: "Feed",
  prs: "Pull requests",
  tasks: "Tasks",
  // The Plain queue as a destination. The alternate sidebar band opens a
  // ticket's workspace; this tool opens the ticket directly.
  plain: "Support",
  catchup: "Catch up",
  supporttinder: "Support Tinder",
  reports: "Reports",
  analytics: "Analytics",
};

/**
 * Both of these were renamed on 2026-08-14. `home` became `prs` because there
 * was never a home: the page has always been the pull request list, and the
 * name promised a place the app does not have. `people` became `feed` because
 * the team is how you scope that page, not what it is for.
 *
 * Stored preferences still carry the old ids, so they are read as the new ones
 * rather than dropped, which would silently un-hide a tool someone had turned
 * off.
 */
const RENAMED_TOOL_IDS: Record<string, SidebarToolId> = {
  home: "prs",
  people: "feed",
};

// The swipe decks are one card at a time, moved on with a thumb. That is the
// wrong shape for a desktop window, which already shows the same unread
// workspaces and waiting tickets as lists you can scan at once, so they are
// offered at phone widths only. Nothing else in the app hides by viewport, so
// the rule lives here rather than in each surface that lists tools.
const PHONE_ONLY_TOOLS: SidebarToolId[] = ["catchup", "supporttinder"];

/** Is this tool offered at the current width? Pull requests is the phone's
 *  root list rather than a tool row, so it drops out there; phone-only tools
 *  drop out everywhere else. */
export function toolFitsViewport(id: SidebarToolId, isPhone: boolean): boolean {
  return isPhone ? id !== "prs" : !PHONE_ONLY_TOOLS.includes(id);
}

const LOCAL_KEY_PREFIX = "opensession-sidebar-hidden-tools:";
const ORDER_LOCAL_KEY_PREFIX = "opensession-sidebar-tool-order:";
// The browser-wide key this pref used to live in. Read once per person, then
// retired, so a sidebar someone had already arranged survives the move.
const LEGACY_LOCAL_KEY = "opensession-sidebar-hidden-tools";
const PREF_KEY = "sidebar-hidden-tools";
const ORDER_PREF_KEY = "sidebar-tool-order";
const TOOLS_CHANGED_EVENT = "opensession-sidebar-tools-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

// A new account starts with the primary destinations: Feed, Pull requests,
// Support, and Catch up. The rest are either empty until something else exists
// (Tasks needs todos, Reports needs automations) or need an integration
// (Support Tinder, Analytics), so shipping them on makes the sidebar look busy
// and broken at once. They are one click away in the Tools band's ••• menu and
// in Settings.
//
// This list is the whole agreement between clients when nobody has chosen:
// absent means these defaults, on the web and in the native app alike. Keep it
// in step with DEFAULT_VISIBLE in packages/clients/ios/OS1/SidebarTools.swift.
const DEFAULT_VISIBLE_TOOLS: SidebarToolId[] = [
  "feed",
  "prs",
  "plain",
  "catchup",
];
// Derived from the visible list so a tool added later defaults to hidden
// rather than silently showing up for everyone.
const DEFAULT_HIDDEN_TOOLS: SidebarToolId[] = SIDEBAR_TOOL_IDS.filter(
  (id) => !DEFAULT_VISIBLE_TOOLS.includes(id),
);

function localKey(user: string): string {
  return `${LOCAL_KEY_PREFIX}${user.trim().toLowerCase() || "anonymous"}`;
}

/** Stored ids as tool ids: renames applied, unknown ids and duplicates dropped. */
export function normalizeHiddenSidebarTools(value: unknown): SidebarToolId[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((id) => RENAMED_TOOL_IDS[id as string] ?? id)
        .filter((id): id is SidebarToolId =>
          SIDEBAR_TOOL_IDS.includes(id as SidebarToolId),
        ),
    ),
  ];
}

export function normalizeSidebarToolOrder(value: unknown): SidebarToolId[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((id) => RENAMED_TOOL_IDS[id as string] ?? id)
        .filter((id): id is SidebarToolId =>
          SIDEBAR_TOOL_IDS.includes(id as SidebarToolId),
        ),
    ),
  ];
}

export function mergeSidebarToolOrder(
  preferred: readonly SidebarToolId[],
  available: readonly SidebarToolId[] = SIDEBAR_TOOL_IDS,
): SidebarToolId[] {
  const allowed = new Set(available);
  const ordered = normalizeSidebarToolOrder(preferred).filter((id) =>
    allowed.has(id),
  );
  const seen = new Set(ordered);
  for (const id of available) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

export function replaceVisibleSidebarToolOrder(
  fullOrder: readonly SidebarToolId[],
  visibleOrder: readonly SidebarToolId[],
): SidebarToolId[] {
  const visible = new Set(visibleOrder);
  const queue = [...visibleOrder];
  return mergeSidebarToolOrder(
    fullOrder.map((id) => (visible.has(id) ? (queue.shift() ?? id) : id)),
  );
}

/**
 * What this person chose, or null when they never have.
 *
 * The difference matters: an empty list means "show everything", which is a
 * choice, while nothing stored means the defaults. Collapsing the two would
 * make a person who deliberately switched every tool on indistinguishable
 * from a fresh account, and hand them the four hidden ones back.
 */
function readStored(user: string): Set<SidebarToolId> | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(localKey(user));
  } catch {
    return null;
  }
  if (raw === null) return adoptLegacy(user);
  try {
    return new Set(normalizeHiddenSidebarTools(JSON.parse(raw)));
  } catch {
    return null;
  }
}

function readStoredOrder(user: string): SidebarToolId[] {
  try {
    return normalizeSidebarToolOrder(
      JSON.parse(
        localStorage.getItem(
          `${ORDER_LOCAL_KEY_PREFIX}${user.trim().toLowerCase() || "anonymous"}`,
        ) || "[]",
      ),
    );
  } catch {
    return [];
  }
}

/** Move the pre-2026-08-15 browser-wide value onto this person, once. */
function adoptLegacy(user: string): Set<SidebarToolId> | null {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_LOCAL_KEY);
  } catch {
    return null;
  }
  if (legacy === null) return null;
  let hidden: Set<SidebarToolId>;
  try {
    hidden = new Set(normalizeHiddenSidebarTools(JSON.parse(legacy)));
  } catch {
    // Unreadable, and nothing to carry over. Drop it so the next read is
    // the ordinary "never chosen" case rather than this one again.
    try {
      localStorage.removeItem?.(LEGACY_LOCAL_KEY);
    } catch {}
    return null;
  }
  writeLocal(user, hidden);
  try {
    localStorage.removeItem?.(LEGACY_LOCAL_KEY);
  } catch {}
  return hidden;
}

function writeLocal(user: string, hidden: Set<SidebarToolId>) {
  try {
    localStorage.setItem(
      localKey(user),
      JSON.stringify(normalizeHiddenSidebarTools([...hidden])),
    );
  } catch {}
}

function writeLocalOrder(user: string, order: readonly SidebarToolId[]) {
  try {
    localStorage.setItem(
      `${ORDER_LOCAL_KEY_PREFIX}${user.trim().toLowerCase() || "anonymous"}`,
      JSON.stringify(normalizeSidebarToolOrder(order)),
    );
  } catch {}
}

export function readHiddenSidebarTools(): Set<SidebarToolId> {
  return readStored(getCurrentUser()) ?? new Set(DEFAULT_HIDDEN_TOOLS);
}

export function getSidebarToolOrder(): SidebarToolId[] {
  return mergeSidebarToolOrder(readStoredOrder(getCurrentUser()));
}

function announce() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TOOLS_CHANGED_EVENT));
}

let writeStamp = 0;
let saveChain: Promise<unknown> = Promise.resolve();

function commit(user: string, hidden: Set<SidebarToolId>) {
  writeStamp++;
  writeLocal(user, hidden);
  announce();
  saveChain = saveChain
    .catch(() => {})
    .then(() =>
      saveUiPrefsApi(user, {
        [PREF_KEY]: JSON.stringify(normalizeHiddenSidebarTools([...hidden])),
      }),
    )
    .catch(() => {});
}

export function setSidebarToolVisible(id: SidebarToolId, visible: boolean) {
  const user = getCurrentUser();
  const hidden = readStored(user) ?? new Set(DEFAULT_HIDDEN_TOOLS);
  if (visible) hidden.delete(id);
  else hidden.add(id);
  commit(user, hidden);
}

export function setSidebarToolOrder(order: readonly SidebarToolId[]) {
  const user = getCurrentUser();
  const next = mergeSidebarToolOrder(order);
  writeStamp++;
  writeLocalOrder(user, next);
  announce();
  saveChain = saveChain
    .catch(() => {})
    .then(() =>
      saveUiPrefsApi(user, {
        [ORDER_PREF_KEY]: JSON.stringify(next),
      }),
    )
    .catch(() => {});
}

async function hydrate(user: string) {
  const stampAtStart = writeStamp;
  let prefs: Record<string, string>;
  try {
    prefs = await fetchUiPrefs(user);
  } catch {
    return;
  }
  if (writeStamp !== stampAtStart) return;
  const serverValue = prefs[PREF_KEY];
  if (typeof serverValue === "string") {
    try {
      const serverHidden = new Set(
        normalizeHiddenSidebarTools(JSON.parse(serverValue)),
      );
      const local = readStored(user);
      if (
        !local ||
        JSON.stringify([...serverHidden].sort()) !==
          JSON.stringify([...local].sort())
      ) {
        writeLocal(user, serverHidden);
        announce();
      }
    } catch {}
  } else {
    // No server value yet. Push this browser's choice up so the phone stops
    // showing what was switched off here, but only when there IS a choice:
    // writing the defaults would turn an untouched account into a decision
    // nobody made.
    const local = readStored(user);
    if (local) {
      void saveUiPrefsApi(user, {
        [PREF_KEY]: JSON.stringify(normalizeHiddenSidebarTools([...local])),
      }).catch(() => {});
    }
  }

  const serverOrderValue = prefs[ORDER_PREF_KEY];
  if (typeof serverOrderValue === "string") {
    try {
      const serverOrder = mergeSidebarToolOrder(
        normalizeSidebarToolOrder(JSON.parse(serverOrderValue)),
      );
      if (
        JSON.stringify(serverOrder) !==
        JSON.stringify(mergeSidebarToolOrder(readStoredOrder(user)))
      ) {
        writeLocalOrder(user, serverOrder);
        announce();
      }
    } catch {}
  } else {
    const localOrder = readStoredOrder(user);
    if (localOrder.length) {
      void saveUiPrefsApi(user, {
        [ORDER_PREF_KEY]: JSON.stringify(mergeSidebarToolOrder(localOrder)),
      }).catch(() => {});
    }
  }
}

export function onSidebarToolsChanged(listener: () => void) {
  window.addEventListener(TOOLS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(TOOLS_CHANGED_EVENT, listener);
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  whenCurrentUserReady((user) => void hydrate(user));
  window.addEventListener(USER_CHANGE_EVENT, () => {
    writeStamp++;
    announce();
    void hydrate(getCurrentUser());
  });
  window.addEventListener("storage", (event) => {
    if (
      event.key?.startsWith(LOCAL_KEY_PREFIX) ||
      event.key?.startsWith(ORDER_LOCAL_KEY_PREFIX)
    ) {
      writeStamp++;
      announce();
    } else if (
      event.key === "opensession-user" ||
      event.key === "backstage-user"
    ) {
      writeStamp++;
      announce();
      void hydrate(getCurrentUser());
    }
  });
}
