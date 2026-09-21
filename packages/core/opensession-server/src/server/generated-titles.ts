/**
 * Auto-generated short "summary" titles for sessions — the Conductor-style
 * 3-6 word name (e.g. "Add onboarding flow") instead of the raw first line of
 * the prompt. Lives in a backstage-owned registry keyed by unified session id,
 * applied UNDER the manual rename registry (title-overrides) but OVER the
 * derived first-line title in getAllSessions.
 *
 * Generation is a one-shot Haiku call (see generateSessionTitle), fired in the
 * background at session creation so it never blocks the create path. Later
 * prompts go through refreshGeneratedTitle, which asks the same cheap model
 * whether the conversation moved on to a different task and only then
 * replaces the title (a manual rename always wins).
 *
 * Reads stay on the legacy synchronous registry cache (getAllSessions calls
 * getGeneratedTitle once per row). Every mutation is asynchronous.
 */
import { catalogNativeSessions } from "./session-catalog-read";
import { readFileSync, existsSync, statSync } from "fs";
import { readFile, stat } from "fs/promises";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { oneShot as runOneShot, type OneShotOpts } from "./one-shot";
import { getTitleOverride, getTitleOverrideAsync } from "./title-overrides";
import { isMachineActor } from "./session-actors";
import { stripContext } from "./prompt-context";
import type { NativeSessionFile } from "./types";

const REGISTRY_PATH = `${OPENSESSION_SESSIONS_DIR}/generated-titles.json`;

type OneShotFn = (prompt: string, opts?: OneShotOpts) => Promise<string | null>;

let oneShot: OneShotFn = runOneShot;

/** Test seam: swap the model call. Returns a restore function. */
export function __setGeneratedTitleOneShotForTest(fn: OneShotFn): () => void {
  const previous = oneShot;
  oneShot = fn;
  return () => {
    oneShot = previous;
  };
}

let cache: Record<string, string> | null = null;
let cacheMtimeMs = 0;
let lastStatAt = 0;

function load(): Record<string, string> {
  // Re-read when the file changed underneath us. A restart overlaps two
  // processes (the outgoing one keeps finishing title calls while draining),
  // and this module used to cache the map for the process lifetime — so a
  // sibling's titles stayed invisible until the next restart, and our next
  // whole-map write silently dropped them. Stat at most once a second:
  // getAllSessions calls this once per session, thousands of times a scan.
  const now = Date.now();
  if (cache && now - lastStatAt < 1000) return cache;
  lastStatAt = now;
  try {
    const mtime = existsSync(REGISTRY_PATH)
      ? statSync(REGISTRY_PATH).mtimeMs
      : 0;
    if (cache && mtime === cacheMtimeMs) return cache;
    cache = mtime ? JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) : {};
    cacheMtimeMs = mtime;
  } catch {
    cache ??= {};
  }
  return cache!;
}

export function getGeneratedTitle(id: string): string | undefined {
  return load()[id];
}

/** Non-blocking counterpart for prompt-time naming. Legacy list reads use the cache. */
export async function getGeneratedTitleAsync(
  id: string,
): Promise<string | undefined> {
  try {
    return JSON.parse(await readFile(REGISTRY_PATH, "utf-8"))[id];
  } catch {
    return cache?.[id];
  }
}

let writeChain: Promise<void> = Promise.resolve();

/** Merge one title into the whole-map registry. Writes are chained; entries
 * on disk win over the cache (a sibling process may have written since we
 * last read) and the cache follows only a write that landed. */
function setGeneratedTitle(id: string, title: string): Promise<void> {
  const write = writeChain.then(async () => {
    let onDisk: Record<string, string> = {};
    try {
      onDisk = JSON.parse(await readFile(REGISTRY_PATH, "utf-8"));
    } catch {}
    const next = { ...cache, ...onDisk, [id]: title };
    await writeJsonAtomicAsync(REGISTRY_PATH, next);
    cache = next;
    try {
      cacheMtimeMs = (await stat(REGISTRY_PATH)).mtimeMs;
    } catch {}
  });
  writeChain = write.catch(() => {});
  return write;
}

type TitleJob = () => Promise<string | null>;
type Parked = { job: TitleJob; settle: Array<(t: string | null) => void> };
const lanes = new Map<string, { parked: Parked | null }>();

/** One title call per session at a time. A request that arrives while one
 * runs is parked, a newer parked request replaces an older one, and every
 * parked waiter settles with the outcome of the job that actually ran. */
function scheduleTitleJob(id: string, job: TitleJob): Promise<string | null> {
  const busy = lanes.get(id);
  if (busy) {
    const settle = busy.parked?.settle ?? [];
    return new Promise((resolve) => {
      busy.parked = { job, settle: [...settle, resolve] };
    });
  }
  const lane = { parked: null as Parked | null };
  lanes.set(id, lane);
  const safely = (work: TitleJob) => work().catch(() => null);
  const first = safely(job);
  void first.then(async () => {
    while (lane.parked) {
      const { job: next, settle } = lane.parked;
      lane.parked = null;
      const outcome = await safely(next);
      for (const resolve of settle) resolve(outcome);
    }
    lanes.delete(id);
  });
  return first;
}

/** Trim a raw model output into a clean short title, or "" if unusable. */
function sanitizeTitle(raw: string): string {
  const line = raw
    .trim()
    .split("\n")[0] // first line only
    .replace(/^["'`]+|["'`]+$/g, "") // surrounding quotes
    .replace(/\s+/g, " ")
    .trim();
  // The model occasionally answers instead of naming ("This isn't a coding
  // task — it's a question to investigate. The ..."), which the 60-char slice
  // would bake in as a title. Reject prose — long-winded output, an internal
  // sentence break, or a first-person/deictic opener no imperative title has —
  // and keep the derived first-line title instead.
  if (
    line.split(" ").length > 9 ||
    /\.\s/.test(line) ||
    /^(i|i'm|this|that|there|sorry|it)\b/i.test(line)
  )
    return "";
  return line
    .replace(/[.\s]+$/g, "") // trailing period/space
    .slice(0, 60)
    .trim();
}

/**
 * Generate and store a short summary title for a session from its opening
 * prompt, unless one already exists. Fire-and-forget: returns the title on
 * success, or null (leaves the derived first-line title in place). Callers
 * should invalidate their sessions cache when a non-null title comes back.
 */
export async function ensureGeneratedTitle(
  id: string,
  prompt: string,
  user?: string,
  _model?: string,
): Promise<string | null> {
  const source = prompt.trim().slice(0, 2000);
  if (!source) return null;
  return scheduleTitleJob(id, async () => {
    // A parked duplicate (sweep + prompt) or a rename since the request.
    if ((await getGeneratedTitleAsync(id)) || (await getTitleOverrideAsync(id)))
      return null;
    // Desk sessions keep their fixed title (direct file read — importing the
    // sessions cache here would be an import cycle).
    if ((await readSessionDoc(id))?.desk) return null;

    const out = await oneShot(
      `Summarize this task as a short title of 3 to 6 words, phrased as an imperative like a git branch or PR title (e.g. "Add onboarding flow", "Fix layout thumbnails", "Raise timeline playhead"). Sentence case, no trailing punctuation, no quotes, no code. Always name the task, even when it is a question, an investigation or a discussion rather than a code change — never comment on the task itself. Output ONLY the title, nothing else.\n\nTask:\n"""\n${source}\n"""`,
      { user, label: "generated-titles" },
    );
    if (!out) return null;

    const title = sanitizeTitle(out);
    if (!title || (await getTitleOverrideAsync(id))) return null; // renamed while in flight
    const stored = await persistTitle(id, title);
    if (stored) await applyPendingWorkspaceTitle(id, stored);
    return stored;
  });
}

async function readSessionDoc(id: string): Promise<NativeSessionFile | null> {
  try {
    return JSON.parse(
      await readFile(`${OPENSESSION_SESSIONS_DIR}/${id}.json`, "utf-8"),
    );
  } catch {
    return null;
  }
}

async function persistTitle(id: string, title: string): Promise<string | null> {
  try {
    await setGeneratedTitle(id, title);
  } catch (e) {
    // A `void ensureGeneratedTitle(...)` caller would surface a write failure
    // (disk full) as an unhandled rejection — a missing title is not worth that.
    console.warn(`[generated-titles] could not persist title for ${id}:`, e);
    return null;
  }
  return title;
}

/* ------------------------------------------------------------------ *
 * Refresh on a later prompt. Most later prompts continue the same work, so
 * the refresh is biased towards keeping: conversational shapes are filtered
 * here without a model call, and the model answers KEEP unless the message
 * clearly starts different work.
 * ------------------------------------------------------------------ */

/** The session fields that pin a title regardless of what is prompted. */
export type TitleRefreshSession = {
  title?: string;
  desk?: boolean;
  goalId?: string;
  automationId?: string;
  automation?: string;
};

const PLACEHOLDER_TITLES = new Set(["", "new session", "untitled"]);

// A whole message made of acknowledgements and go-aheads ("yes", "ok go
// ahead", "looks good, ship it please"). Anything else, however short
// ("Fix login tests", "How does login work?"), is for the model to judge.
const ACK_TOKEN =
  "y(?:es|ep|eah|up)|ok(?:ay)?|sure|fine|right|agreed|correct|exactly|no(?:pe)?|not yet|wait|stop|cancel|hold on|approved?|good|great|perfect|nice|cool|awesome|thanks?(?: you)?|ty|lgtm|sgtm|looks good|sounds good|works|go(?: ahead| for it)?|do (?:it|that|this)|please(?: do)?|continue|proceed|carry on|keep going|next|retry|try again|ship it|merge(?: it)?|land it|push(?: it)?|commit(?: it)?|fix (?:it|that|this)|done|now|then";
const FOLLOW_UP_RE = new RegExp(`^(?:(?:${ACK_TOKEN})[\\s,.!]*){1,6}$`, "i");

export function isFollowUpShapedPrompt(message: string): boolean {
  return FOLLOW_UP_RE.test(message);
}

function refreshPrompt(current: string, source: string): string {
  return (
    `A conversation with a coding agent is titled "${current}". The person just sent the message below.\n\n` +
    `Decide whether the message starts a meaningfully different task from the title, or continues the same work (a follow-up, an answer, a correction, a refinement, a review of the result, or a next step of the same task).\n\n` +
    `If it continues the same work, output exactly: KEEP\n` +
    `If it starts a different task, output ONLY a new title of 3 to 6 words for that task, phrased as an imperative like a git branch or PR title (e.g. "Add onboarding flow", "Fix layout thumbnails"). Sentence case, no trailing punctuation, no quotes, no code. When in doubt, output KEEP.\n\n` +
    `Message:\n"""\n${source}\n"""`
  );
}

function saidKeep(out: string): boolean {
  const first = out.trim().split("\n")[0].trim();
  return /^["'`*]*keep["'`*.!]*$/i.test(first);
}

// Remember only the latest judgment per session: suppress redelivery without
// preventing a return to an earlier task. Bounded; insertion order evicts.
const judged = new Map<string, string>();
const JUDGED_MAX = 1000;
function rememberJudged(id: string, key: string): void {
  judged.delete(id);
  judged.set(id, key);
  if (judged.size > JUDGED_MAX)
    judged.delete(judged.keys().next().value as string);
}

/**
 * Re-judge a session's title against a later prompt. Resolves with the new
 * title when the prompt started a different task and it was stored, else
 * null. Never throws. A manual rename, a fixed-title session (desk, goal,
 * automation), a machine-sent prompt, a follow-up shaped message and a
 * session without any title yet are all left alone without a model call.
 */
export async function refreshGeneratedTitle(
  id: string,
  prompt: string,
  opts: { user?: string; session?: TitleRefreshSession } = {},
): Promise<string | null> {
  const { user, session } = opts;
  if (session?.desk || session?.goalId || session?.automationId) return null;
  if (session?.automation) return null;
  if (isMachineActor(user)) return null;
  const message = stripContext(prompt).trim();
  if (!message || message.startsWith("<!--os:")) return null;
  if (isFollowUpShapedPrompt(message)) return null;
  const source = message.slice(0, 2000);

  return scheduleTitleJob(id, async () => {
    // Judged against the title in force when the call runs: a parked refresh
    // follows whatever the previous one stored.
    const current = (
      (await getGeneratedTitleAsync(id)) ??
      session?.title ??
      ""
    ).trim();
    if (PLACEHOLDER_TITLES.has(current.toLowerCase())) return null;
    const judgedKey = `${current}\n${source}`;
    if (judged.get(id) === judgedKey || (await getTitleOverrideAsync(id)))
      return null;

    const out = await oneShot(refreshPrompt(current, source), {
      user,
      label: "generated-titles-refresh",
    });
    if (!out) return null; // model unavailable: the next prompt may retry
    rememberJudged(id, judgedKey);
    if (saidKeep(out)) return null;
    const title = sanitizeTitle(out);
    if (!title || title.toLowerCase() === current.toLowerCase()) return null;
    if (await getTitleOverrideAsync(id)) return null; // renamed while in flight
    const stored = await persistTitle(id, title);
    if (stored) rememberJudged(id, `${stored}\n${source}`);
    return stored;
  });
}

/* ------------------------------------------------------------------ *
 * A session that started empty may have minted a workspace that still wears
 * a provisional name; its session file carries a `pendingWorkspaceTitle`
 * marker. The FIRST generated title names that workspace once (whichever
 * path produced it: prompt, retry or sweep), only while it still wears the
 * marked name (a manual workspace rename wins). Later title refreshes never
 * touch the workspace.
 * ------------------------------------------------------------------ */

export type PendingWorkspaceTitle = { id: string; name: string };

export type PendingWorkspaceTitleIO = {
  /** Atomically read and clear the marker on the session document. */
  claimMarker(sessionId: string): Promise<PendingWorkspaceTitle | null>;
  getWorkspace(id: string): Promise<{ name: string } | null>;
  renameWorkspace(
    id: string,
    name: string,
    expectedName: string,
  ): Promise<boolean>;
};

function defaultPendingWorkspaceTitleIO(): PendingWorkspaceTitleIO {
  // Dynamic imports: a static import of the session cache would be a cycle.
  return {
    async claimMarker(sessionId) {
      // Most sessions carry no marker: check the file before paying a write.
      if (!(await readSessionDoc(sessionId))?.pendingWorkspaceTitle)
        return null;
      const { updateSessionFile } = await import("./session-cache");
      let marker: PendingWorkspaceTitle | null = null;
      await updateSessionFile(sessionId, (data) => {
        const { pendingWorkspaceTitle, ...rest } = data;
        marker = pendingWorkspaceTitle ?? null;
        return pendingWorkspaceTitle ? rest : data;
      });
      return marker;
    },
    async getWorkspace(id) {
      const { getWorkspace } = await import("./workspaces");
      return getWorkspace(id);
    },
    async renameWorkspace(id, name, expectedName) {
      const { updateWorkspace } = await import("./workspaces");
      const renamed = await updateWorkspace(id, { name }, expectedName);
      return renamed?.name === name;
    },
  };
}

/** Name the marked workspace after the session's first generated title. The
 * marker is claimed (cleared) first so two results can never rename twice.
 * Fail-soft: resolves true only when the workspace was renamed. */
export async function applyPendingWorkspaceTitle(
  sessionId: string,
  title: string,
  io: PendingWorkspaceTitleIO = defaultPendingWorkspaceTitleIO(),
): Promise<boolean> {
  try {
    const marker = await io.claimMarker(sessionId);
    if (!marker?.id || typeof marker.name !== "string") return false;
    const current = await io.getWorkspace(marker.id);
    if (!current || current.name !== marker.name) return false;
    return await io.renameWorkspace(marker.id, title, marker.name);
  } catch (e) {
    console.warn(
      `[generated-titles] could not name workspace for ${sessionId}:`,
      e,
    );
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Back-fill sweep
 *
 * Generation is fire-and-forget at session creation, and the only retry is
 * the session's NEXT prompt (run-session.ts). So any interruption while the
 * one-shot is in flight — the ~10-16s Haiku call — strands the title FOREVER
 * for a session the user never prompts again. Two real triggers, both measured
 * over the week of 2026-07-24..31: 228 service restarts (every backend edit
 * needs one, and a session created within ~15s of one loses its call), and a
 * 40-minute window on 07-27 10:17-10:57 where no model turn would start
 * at all, so every queued one-shot parked until the restart killed it.
 *
 * This sweep closes that hole: anything still wearing its raw first-line
 * title gets another chance, so a lost title is a delay, not a permanent
 * scar. It is deliberately conservative — see eligibility below.
 * ------------------------------------------------------------------ */

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_FIRST_DELAY_MS = 3 * 60 * 1000; // let the engine warm up first
const SWEEP_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 10; // one-shots serialize on a shared server; stay polite

/**
 * Sessions still wearing a raw first-line title that we could summarize.
 *
 * Eligibility mirrors the create-path gating, erring towards skipping: only
 * interactive `os-`/`bks-<uuid>` sessions (so `bks-ghpr-*` review/auto-fix sessions
 * keep their deliberate names), never desk/goal/automation sessions, never a
 * manual rename, and never a title carrying the " · " prefix convention that
 * marks a deliberately-composed name.
 */
export async function sweepCandidates(): Promise<
  Array<{ id: string; title: string }>
> {
  const cutoff = Date.now() - SWEEP_MAX_AGE_MS;
  const out: Array<{ id: string; title: string; created: number }> = [];
  for (const d of await catalogNativeSessions()) {
    const id = d.id;
    if (!/^(os|bks)-[0-9a-f]{8}-/.test(id)) continue;
    if (getGeneratedTitle(id) || getTitleOverride(id)) continue;
    if (d.desk || d.goalId || d.automationId) continue;
    const title = typeof d.title === "string" ? d.title.trim() : "";
    if (!title || title === "New session" || title.includes(" · ")) continue;
    const created = Date.parse(d.createdAt ?? "");
    if (!Number.isFinite(created) || created < cutoff) continue;
    out.push({ id, title, created });
  }
  // Newest first: those are the ones visible in the sidebar right now.
  out.sort((a, b) => b.created - a.created);
  return out.slice(0, SWEEP_BATCH).map(({ id, title }) => ({ id, title }));
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Periodically re-try titles that were lost mid-flight. */
export function startGeneratedTitleSweep(
  onChange?: (sessionId: string) => void,
): void {
  if (sweepTimer) return;

  const sweep = async () => {
    const candidates = await sweepCandidates();
    if (!candidates.length) return;
    let filled = 0;
    for (const { id, title } of candidates) {
      // Summarize the stored first-line title, exactly like run-session's
      // retry — never a later message, which would rename the session after
      // the fact.
      try {
        if (await ensureGeneratedTitle(id, title)) {
          filled++;
          onChange?.(id);
        }
      } catch {}
    }
    if (filled > 0)
      console.log(`[generated-titles] back-filled ${filled} title(s)`);
  };

  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void sweep()
      .catch((error) =>
        console.error("[generated-titles] catalog sweep deferred:", error),
      )
      .finally(() => {
        running = false;
      });
  };
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  setTimeout(run, SWEEP_FIRST_DELAY_MS);
  console.log("[generated-titles] back-fill sweep started (10m interval)");
}
