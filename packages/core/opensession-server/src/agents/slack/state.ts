/**
 * Shared mutable state for the Slack agent.
 *
 * Centralized here so multiple modules (handlers, queue, worktree-channels,
 * github-reviews, index) can read/write without circular imports.
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { configuredPaths, defaultRepo } from "../../server/config";
import { statePath } from "../../server/paths";
import type { SlackSessionFile } from "../../server/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Slack loop's in-memory view of a session: the on-disk record with the
 *  fields the loop always has narrowed to required. One type, so a field can't
 *  exist in memory but not in the write path (repoId used to). */
export interface SlackSession extends SlackSessionFile {
  channel: string;
  threadTs: string;
  userId: string;
  claudeSessionId: string | null;
  worktreeDir: string | null;
  branch: string | null;
  createdAt: string;
  lastActivity: string;
}

export interface PendingAnswer {
  resolve: (answer: string) => void;
  messageTs: string;
  channel: string;
  threadTs: string;
  sessionKey: string;
  timeoutId: ReturnType<typeof setTimeout>;
  questionText: string;
  header: string;
}

/** Sentinel returned to handleAskUserQuestion when the user cancels mid-modal. */
export const CANCELLED_ANSWER = "__CANCELLED__";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// statePath, not $HOME directly: with OPENSESSION_STATE_DIR set (dev/demo
// instances) this store isolates like every other one, so a second instance
// can neither read nor patch the live loop's session files. Unset ⇒ $HOME.
export const SESSION_DIR = statePath(".slack-sessions");
// Config-driven: the repos registry and paths in the instance config file.
export const DEFAULT_CWD = defaultRepo().repo;
export const MCP_CONFIG_PATH = configuredPaths().mcpConfig;
export const GITHUB_REPO = defaultRepo().ghRepo;

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

// Parked on globalThis: the engine-id sync (server/agent-session-sync.ts)
// writes into this map from outside the Slack loop, and a hot reload must not
// fork the loop's copy from the writer's.
export const activeSessions: Map<string, SlackSession> = ((
  globalThis as any
).__slackActiveSessions ??= new Map());
export const pendingAnswers = new Map<string, PendingAnswer>();

// Inbound Slack event dedup, persisted across restarts. Slack retries a delivery
// when it didn't get a 200 — which, since we ack every event immediately, means
// we were down/erroring when it first arrived. The old in-memory-only Set meant a
// retry landing after a restart was either blindly dropped (event lost forever) or
// reprocessed (duplicate handling). Persisting eventId -> expiry lets us drop only
// events we truly handled and process the ones we missed. 5-min TTL matches Slack's
// retry window.
const PROCESSED_EVENTS_STORE = `${SESSION_DIR}/processed-events.json`;
const PROCESSED_EVENT_TTL_MS = 5 * 60 * 1000;
const processedEventExpiry = new Map<string, number>();

function persistProcessedEvents(): void {
  try {
    writeJsonAtomic(PROCESSED_EVENTS_STORE, [...processedEventExpiry], false);
  } catch (e) {
    console.error("[slack] Failed to persist processed events:", e);
  }
}

/** Load the persisted dedup set on boot, dropping any already-expired ids. */
export function loadProcessedEvents(): void {
  try {
    if (!existsSync(PROCESSED_EVENTS_STORE)) return;
    const entries = JSON.parse(
      readFileSync(PROCESSED_EVENTS_STORE, "utf-8"),
    ) as [string, number][];
    const now = Date.now();
    for (const [id, exp] of entries)
      if (exp > now) processedEventExpiry.set(id, exp);
  } catch (e) {
    console.error("[slack] Failed to load processed events:", e);
  }
}

/** True if we already handled this event id (and it hasn't aged out). */
export function isEventProcessed(id: string): boolean {
  const exp = processedEventExpiry.get(id);
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    processedEventExpiry.delete(id);
    return false;
  }
  return true;
}

/** Mark an event id handled, prune expired ids, and persist. */
export function markEventProcessed(id: string): void {
  const now = Date.now();
  processedEventExpiry.set(id, now + PROCESSED_EVENT_TTL_MS);
  for (const [k, exp] of processedEventExpiry)
    if (exp <= now) processedEventExpiry.delete(k);
  persistProcessedEvents();
}

export let slackTeamId = "";
export let slackBotUserId = "";

export function setSlackTeamId(id: string) {
  slackTeamId = id;
}
export function setSlackBotUserId(id: string) {
  slackBotUserId = id;
}

// ---------------------------------------------------------------------------
// Session key helper
// ---------------------------------------------------------------------------

export function getSessionKey(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}-${threadTs}` : channel;
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

/** Read-modify-write, not a projection. This file has writers outside the loop
 *  (agent-session-sync's piSessionId, `wt new-slack`'s branch-file fields), and
 *  a full-file replace built from a hand-listed set of fields silently dropped
 *  every key the loop doesn't carry. Undefined in-memory fields don't overwrite
 *  what's on disk; an explicit null does (resetting claudeSessionId). */
export async function saveSession(session: SlackSession): Promise<void> {
  const key = getSessionKey(session.channel, session.threadTs);
  const sessionFile = `${SESSION_DIR}/${key}.json`;
  const existing: SlackSessionFile = (await loadSession(key)) ?? {};
  const patch = Object.fromEntries(
    Object.entries(session).filter(([, v]) => v !== undefined),
  );
  writeJsonAtomic(sessionFile, {
    ...existing,
    ...patch,
    codexThreadId: session.codexThreadId ?? existing.codexThreadId ?? null,
    lastActivity: new Date().toISOString(),
  });
}

export async function loadSession(key: string): Promise<SlackSession | null> {
  try {
    const sessionFile = `${SESSION_DIR}/${key}.json`;
    const file = Bun.file(sessionFile);
    if (await file.exists()) {
      return JSON.parse(await file.text()) as SlackSession;
    }
    return null;
  } catch {
    return null;
  }
}

/** Sessions with no activity for this long aren't restored on startup. A reply
 *  in an old thread still revives its session — every handler falls back to
 *  loadSession(sessionKey) when the key isn't in activeSessions. */
const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadActiveSessionsOnStartup(): Promise<void> {
  const { readdirSync, statSync } = require("fs");
  console.log("[slack] Loading active sessions from disk...");

  try {
    const files = readdirSync(SESSION_DIR).filter((f: string) =>
      f.endsWith(".json"),
    );

    let skippedStale = 0;
    for (const file of files) {
      try {
        const key = file.replace(".json", "");
        const session = await loadSession(key);

        if (session && session.claudeSessionId) {
          let lastActive = Date.parse(
            session.lastActivity || session.createdAt || "",
          );
          if (!lastActive) {
            try {
              lastActive = statSync(`${SESSION_DIR}/${file}`).mtimeMs;
            } catch {}
          }
          if (!lastActive || Date.now() - lastActive > STALE_SESSION_MS) {
            skippedStale++;
            continue;
          }
          activeSessions.set(key, session);
          console.log(`[slack] Restored session: ${key}`);
        }
      } catch (e) {
        console.error(`[slack] Error loading session ${file}:`, e);
      }
    }
    if (skippedStale > 0) {
      console.log(
        `[slack] Skipped ${skippedStale} stale session file(s) (idle > 7 days)`,
      );
    }
  } catch {
    console.log("[slack] No active sessions to load");
  }
}
