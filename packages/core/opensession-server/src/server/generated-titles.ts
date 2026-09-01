/**
 * Auto-generated short "summary" titles for sessions — the Conductor-style
 * 3-6 word name (e.g. "Add onboarding flow") instead of the raw first line of
 * the prompt. Lives in a backstage-owned registry keyed by unified session id,
 * applied UNDER the manual rename registry (title-overrides) but OVER the
 * derived first-line title in getAllSessions.
 *
 * Generation is a one-shot Haiku call (see generateSessionTitle), fired in the
 * background at session creation so it never blocks the create path.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { oneShot } from "./one-shot";
import { getTitleOverride } from "./title-overrides";

const REGISTRY_PATH = `${OPENSESSION_SESSIONS_DIR}/generated-titles.json`;

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

function save(registry: Record<string, string>): void {
  cache = registry;
  writeJsonAtomic(REGISTRY_PATH, registry);
  try {
    cacheMtimeMs = statSync(REGISTRY_PATH).mtimeMs;
  } catch {}
}

export function getGeneratedTitle(id: string): string | undefined {
  return load()[id];
}

function setGeneratedTitle(id: string, title: string): void {
  // Merge over what is on disk right now, not just over our cache: save()
  // rewrites the WHOLE map, so persisting a stale cache would delete every
  // title a sibling process stored since we last read.
  let onDisk: Record<string, string> = {};
  try {
    if (existsSync(REGISTRY_PATH))
      onDisk = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {}
  save({ ...onDisk, ...load(), [id]: title });
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
  model?: string,
): Promise<string | null> {
  if (getGeneratedTitle(id)) return null; // already have one
  // Desk sessions keep their fixed title (direct file read — importing the
  // sessions cache here would be an import cycle).
  try {
    const f = `${OPENSESSION_SESSIONS_DIR}/${id}.json`;
    if (existsSync(f) && JSON.parse(readFileSync(f, "utf-8")).desk) return null;
  } catch {}
  const source = prompt.trim().slice(0, 2000);
  if (!source) return null;

  const out = await oneShot(
    `Summarize this task as a short title of 3 to 6 words, phrased as an imperative like a git branch or PR title (e.g. "Add onboarding flow", "Fix layout thumbnails", "Raise timeline playhead"). Sentence case, no trailing punctuation, no quotes, no code. Always name the task, even when it is a question, an investigation or a discussion rather than a code change — never comment on the task itself. Output ONLY the title, nothing else.\n\nTask:\n"""\n${source}\n"""`,
    { user, label: "generated-titles" },
  );
  if (!out) return null;

  const title = sanitizeTitle(out);
  if (!title) return null;
  try {
    setGeneratedTitle(id, title);
  } catch (e) {
    // A `void ensureGeneratedTitle(...)` caller would surface a write failure
    // (disk full) as an unhandled rejection — a missing title is not worth that.
    console.warn(`[generated-titles] could not persist title for ${id}:`, e);
    return null;
  }
  return title;
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
function sweepCandidates(): Array<{ id: string; title: string }> {
  const cutoff = Date.now() - SWEEP_MAX_AGE_MS;
  const out: Array<{ id: string; title: string; created: number }> = [];
  let files: string[] = [];
  try {
    files = readdirSync(OPENSESSION_SESSIONS_DIR);
  } catch {
    return [];
  }
  for (const f of files) {
    // Both id prefixes: `os-` is what every session minted since the rename
    // carries, `bks-` what the older ones kept. Matching only `bks-` left the
    // retry net dead for every new session.
    if (!f.endsWith(".json") || !/^(os|bks)-[0-9a-f]{8}-/.test(f)) continue;
    const id = f.slice(0, -5);
    if (getGeneratedTitle(id) || getTitleOverride(id)) continue;
    let d: any;
    try {
      d = JSON.parse(readFileSync(`${OPENSESSION_SESSIONS_DIR}/${f}`, "utf-8"));
    } catch {
      continue;
    }
    if (!d || typeof d !== "object") continue;
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
export function startGeneratedTitleSweep(onChange?: () => void): void {
  if (sweepTimer) return;

  const sweep = async () => {
    const candidates = sweepCandidates();
    if (!candidates.length) return;
    let filled = 0;
    for (const { id, title } of candidates) {
      // Summarize the stored first-line title, exactly like run-session's
      // retry — never a later message, which would rename the session after
      // the fact.
      try {
        if (await ensureGeneratedTitle(id, title)) filled++;
      } catch {}
    }
    if (filled > 0) {
      console.log(`[generated-titles] back-filled ${filled} title(s)`);
      onChange?.();
    }
  };

  sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  setTimeout(() => void sweep(), SWEEP_FIRST_DELAY_MS);
  console.log("[generated-titles] back-fill sweep started (10m interval)");
}
