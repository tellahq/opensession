/**
 * Which files a session itself wrote.
 *
 * On a per-session worktree this is the same question as `git status`, so
 * nobody needed to ask it. On a repo that uses a shared checkout — Open Session's
 * own, where every session edits one tree on the default branch — the two come
 * apart: the working tree holds every concurrent session's in-flight edits, and
 * a panel that reports that count as "your uncommitted files" is always wrong
 * and sometimes dangerous (its Commit action would sweep the others' work).
 *
 * The transcript is the only record of who wrote what, so this reads the write
 * tools back out of it. Deliberately a superset of "still dirty": callers
 * intersect these paths with `git status`, so a file this session edited and
 * committed simply drops out, and one another session edited never enters.
 *
 * Mirrors touchedFilesFromTool() in src/frontend/components/TurnFooter.tsx —
 * that computes ± counts for the transcript's file chips from the same tool
 * inputs; this only needs the paths. Keep the tool-name list in step with
 * TOOL_ALIASES in ToolCallBlock.tsx.
 */
import { isAbsolute, relative, resolve } from "path";
import { mergedSessionTranscriptAsync } from "./sessions";
import type { TranscriptEntry, UnifiedSession } from "./types";

/** Engines spell the same write tools differently; match on the lowered name. */
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "patch",
  "apply_patch",
  "str_replace_editor",
]);

/** Files named inside a codex-style patch body, which carries no file_path. */
function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (header) out.push(header[1].trim());
  }
  return out;
}

function toolPaths(entry: TranscriptEntry): string[] {
  const input = entry.toolInput;
  if (!input || typeof input !== "object") return [];
  const inp = input as Record<string, unknown>;
  const str = (...names: string[]) => {
    for (const n of names)
      if (typeof inp[n] === "string" && inp[n]) return inp[n] as string;
    return "";
  };
  const file = str(
    "file_path",
    "filePath",
    "notebook_path",
    "notebookPath",
    "path",
  );
  if (file) return [file];
  return patchPaths(str("patchText", "patch"));
}

/**
 * Repo-relative, POSIX-separated, so the paths compare directly against
 * `git status --porcelain` output. A path outside `dir` is dropped: it can't
 * show up in that repo's status, and keeping it would risk a stray match.
 */
function normalize(path: string, dir: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(dir, path);
  const rel = relative(dir, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

interface CacheEntry {
  at: number;
  paths: string[];
}
// Parsing a long transcript is the expensive part, and the git-status panel
// polls every 45s per open client. One parse per session per window serves them
// all; a file this session writes during the window shows up on the next poll.
const CACHE_TTL = 30_000;
const cache = new Map<string, CacheEntry>();

/** What mergedSessionTranscriptAsync needs to find a session's entries. */
export type TouchedSessionRef = Pick<UnifiedSession, "transcriptPath"> & {
  id: string;
};

/** Repo-relative paths of every file this session's tool calls wrote. */
export async function sessionTouchedPaths(
  session: TouchedSessionRef,
  dir: string,
): Promise<string[]> {
  const key = `${session.id}\0${dir}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.paths;

  let paths: string[] = [];
  try {
    const entries = await mergedSessionTranscriptAsync(session);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.type !== "tool_use") continue;
      if (!WRITE_TOOLS.has((entry.toolName || "").toLowerCase())) continue;
      for (const raw of toolPaths(entry)) {
        const rel = normalize(raw, dir);
        if (rel) seen.add(rel);
      }
    }
    paths = [...seen];
  } catch {
    // No transcript (or an unreadable one) means nothing is attributable —
    // callers treat that as "this session wrote nothing here", which keeps
    // another session's work out of this one's count.
  }
  cache.set(key, { at: Date.now(), paths });
  return paths;
}

export function __clearTouchedCacheForTest(): void {
  cache.clear();
}
