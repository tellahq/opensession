// How a turn's work reads in the transcript, as two answers rather than one.
//
// `work` decides whether a turn's working is on screen at all. "running" is
// the default: a tool-only turn stays one summary row, then opens if the agent
// writes an update and folds again when the turn settles. "open" keeps it open,
// while "folded" keeps it closed even during a live narrated turn.
//
// `tools` decides whether grouped tool runs start open. "open" renders every
// call in place; "folded" keeps consecutive routine calls behind their compact
// step row. Individual tool details stay closed either way (ToolCallBlock owns
// its own disclosure).
//
// Deliberately NOT a makeUserPref instance (see lib/user-pref): this module
// manages two stored keys behind one change event with a single batched
// hydrate, and it has to read the pair together to carry the old
// single-value preference forward.

import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";
import { whenCurrentUserReady } from "./auth-ready";

export type TurnWorkPref = "folded" | "running" | "open";
export type ToolCallsPref = "folded" | "open";
export interface TurnActivityPrefs {
  work: TurnWorkPref;
  tools: ToolCallsPref;
}

// The work key keeps its pre-split name, so an existing stored choice is read
// rather than reset. It just answers one of the two questions now.
const WORK_LOCAL = "opensession-turn-activity";
const WORK_PREF = "turn-activity";
const TOOLS_LOCAL = "opensession-tool-calls";
const TOOLS_PREF = "tool-calls";
const DEFAULT_WORK: TurnWorkPref = "running";
const DEFAULT_TOOLS: ToolCallsPref = "folded";
const CHANGE_EVENT = "opensession-turn-activity-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

// The single-value preference this pair replaced. Every old name is one point
// in the new grid, so nobody's setting changes meaning: "messages" was the
// work open with its tool calls folded, "expanded" both open, "collapsed" the
// work away, "auto" the default.
const LEGACY = new Map<string, TurnActivityPrefs>([
  ["messages", { work: "open", tools: "folded" }],
  ["collapsed", { work: "folded", tools: "folded" }],
  ["auto", { work: "running", tools: "folded" }],
  ["expanded", { work: "open", tools: "open" }],
]);

function decodeWork(raw: string | null | undefined): TurnWorkPref | null {
  if (raw === "folded" || raw === "running" || raw === "open") return raw;
  return (raw && LEGACY.get(raw)?.work) || null;
}

function decodeTools(raw: string | null | undefined): ToolCallsPref | null {
  return raw === "folded" || raw === "open" ? raw : null;
}

export function getTurnActivityPrefs(): TurnActivityPrefs {
  const rawWork = localStorage.getItem(WORK_LOCAL);
  return {
    work: decodeWork(rawWork) ?? DEFAULT_WORK,
    // A store still holding the old single value answers both questions
    // from it, so the pair is right before the rewrite below has run.
    tools:
      decodeTools(localStorage.getItem(TOOLS_LOCAL)) ??
      (rawWork ? LEGACY.get(rawWork)?.tools : undefined) ??
      DEFAULT_TOOLS,
  };
}

// The default's absence is its stored form.
function writeLocal(key: string, value: string, fallback: string) {
  if (value === fallback) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

function writePair(prefs: TurnActivityPrefs) {
  writeLocal(WORK_LOCAL, prefs.work, DEFAULT_WORK);
  writeLocal(TOOLS_LOCAL, prefs.tools, DEFAULT_TOOLS);
}

// Rewrite an old single value into the pair once, at load. After this the two
// keys are the only thing read, so setting one can never resurrect the
// other's legacy meaning through the fallback above.
function migrateLegacyLocal() {
  const raw = localStorage.getItem(WORK_LOCAL);
  const legacy = raw ? LEGACY.get(raw) : undefined;
  if (legacy) writePair(legacy);
}

// Bumped on every local set; an in-flight hydration only applies if nothing
// was set while it was fetching (the user's fresh choice beats a stale read).
let writeStamp = 0;
let saveQueue: Promise<void> = Promise.resolve();

function enqueueSave(
  user: string,
  prefs: Record<string, string>,
  expected?: Record<string, string | null>,
  onSaved?: () => void,
) {
  saveQueue = saveQueue
    .catch(() => {})
    .then(() => saveUiPrefsApi(user, prefs, expected))
    .then(
      () => {
        onSaved?.();
      },
      () => undefined,
    );
}

function set(patch: Partial<TurnActivityPrefs>) {
  writeStamp++;
  const next = { ...getTurnActivityPrefs(), ...patch };
  writePair(next);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  // Patch only the control that moved. Otherwise a stale browser changing
  // tool calls could put an older Steps value back on the account. Values are
  // explicit even at their defaults so resets still propagate across devices.
  const changed: Record<string, string> = {};
  if (patch.work !== undefined) changed[WORK_PREF] = next.work;
  if (patch.tools !== undefined) changed[TOOLS_PREF] = next.tools;
  enqueueSave(getCurrentUser(), changed);
}

export function setTurnWorkPref(work: TurnWorkPref) {
  set({ work });
}

export function setToolCallsPref(tools: ToolCallsPref) {
  set({ tools });
}

async function hydrate(user: string) {
  const stampAtStart = writeStamp;
  let prefs: Record<string, string>;
  try {
    prefs = await fetchUiPrefs(user);
  } catch {
    return; // offline/error: keep the local cache
  }
  if (writeStamp !== stampAtStart) return; // user changed it mid-fetch
  const legacy = LEGACY.get(prefs[WORK_PREF]);
  const serverWork = decodeWork(prefs[WORK_PREF]);
  const serverTools = decodeTools(prefs[TOOLS_PREF]) ?? legacy?.tools ?? null;
  const local = getTurnActivityPrefs();
  let changed = false;
  const pushUp: Record<string, string> = {};
  if (serverWork !== null) {
    if (serverWork !== local.work) {
      writeLocal(WORK_LOCAL, serverWork, DEFAULT_WORK);
      changed = true;
    }
  } else if (local.work !== DEFAULT_WORK) {
    // This browser has a local value the server doesn't know yet.
    pushUp[WORK_PREF] = local.work;
  }
  if (serverTools !== null) {
    if (serverTools !== local.tools) {
      writeLocal(TOOLS_LOCAL, serverTools, DEFAULT_TOOLS);
      changed = true;
    }
  } else if (local.tools !== DEFAULT_TOOLS) {
    pushUp[TOOLS_PREF] = local.tools;
  }
  // The account is still stored as the old single value: write the pair back
  // so every other client reads it without needing the mapping.
  if (legacy) {
    pushUp[WORK_PREF] = legacy.work;
    pushUp[TOOLS_PREF] = legacy.tools;
  }
  if (changed) window.dispatchEvent(new Event(CHANGE_EVENT));
  if (Object.keys(pushUp).length) {
    enqueueSave(
      user,
      pushUp,
      legacy
        ? {
            [WORK_PREF]: prefs[WORK_PREF],
            [TOOLS_PREF]: prefs[TOOLS_PREF] ?? null,
          }
        : undefined,
      () => {
        // A failed compare-and-set returns the winning server map. Fetch it
        // again rather than leaving this device on its stale legacy mapping.
        // A local choice made meanwhile stays in charge and skips the read.
        if (writeStamp === stampAtStart && getCurrentUser() === user)
          void hydrate(user);
      },
    );
  }
}

migrateLegacyLocal();
whenCurrentUserReady((user) => void hydrate(user));
window.addEventListener(
  USER_CHANGE_EVENT,
  () => void hydrate(getCurrentUser()),
);

export function onTurnActivityChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
  if (e.key === WORK_LOCAL || e.key === TOOLS_LOCAL)
    window.dispatchEvent(new Event(CHANGE_EVENT));
});
