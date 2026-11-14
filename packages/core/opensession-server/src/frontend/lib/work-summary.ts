import {
  canonicalToolName,
  toolDetail,
  toolFamily,
  type ToolDetail,
  type ToolFamily,
} from "@tellahq/opensession-protocol/tool-presentation";
import type { TranscriptEntry } from "./types";

/**
 * What a run of tool calls did, as a sentence: "Ran 3 commands, read 2
 * files, edited 1 file". A count of steps says how much happened; this says
 * what, which is the question a folded turn is asked.
 *
 * Families, not tool names: three engines name the same tool three ways, and
 * "Bash ×3 · Read ×2" asks to be decoded. Clauses keep the order the work
 * first happened in, so the sentence reads the way the turn went.
 *
 * Failures are deliberately not counted here. A failed command is routine
 * (a test that was meant to fail, a grep with no match), and a count of them
 * on the folded row read as a turn-level alert; the call's own row says so
 * once the fold is open.
 */

type ClauseKind = Exclude<ToolFamily, "mcp" | "other"> | "tool" | "follow-up";

interface Clause {
  kind: ClauseKind;
  /** Calls; distinct files for the two families that are about files, and
   *  distinct commands for looks at a background one. */
  count: number;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function clauseText({ kind, count }: Clause): string {
  switch (kind) {
    case "run":
      return `ran ${plural(count, "command")}`;
    case "file":
      return `read ${plural(count, "file")}`;
    case "edit":
      return `edited ${plural(count, "file")}`;
    case "find":
      return `ran ${plural(count, "search", "searches")}`;
    case "web":
      return `read ${plural(count, "web page")}`;
    case "agent":
      return `started ${plural(count, "agent")}`;
    case "skill":
      return `loaded ${plural(count, "skill")}`;
    case "checklist":
      return "updated the plan";
    case "tool":
      return `called ${plural(count, "tool")}`;
    case "follow-up":
      return `checked on ${plural(count, "command")}`;
  }
}

/** What the call's own row would say: the files it names, or its text. */
function entryDetail(entry: TranscriptEntry): ToolDetail {
  return (
    entry.presentation?.detail ??
    toolDetail(entry.toolName || "", entry.toolInput)
  );
}

/** The files one call is about, when the call says so. */
function entryPaths(entry: TranscriptEntry): string[] {
  const detail = entryDetail(entry);
  if (detail.kind === "path") return [detail.path];
  if (detail.kind === "paths") return detail.paths;
  return [];
}

/** Waiting on or stopping a background command is not another command run:
 * five looks at one build are one command checked on. */
const FOLLOW_UPS = new Set(["BashOutput", "KillShell"]);

/** The background command a follow-up names (its row's whole detail). */
function followUpId(entry: TranscriptEntry): string {
  const detail = entryDetail(entry);
  return detail.kind === "text" ? detail.text : "";
}

function clauseKind(entry: TranscriptEntry): ClauseKind {
  if (
    FOLLOW_UPS.has(
      entry.presentation?.canonical ?? canonicalToolName(entry.toolName),
    )
  )
    return "follow-up";
  const family = entry.presentation?.family ?? toolFamily(entry.toolName || "");
  return family === "mcp" || family === "other" ? "tool" : family;
}

function workSummaryClauses(items: readonly TranscriptEntry[]): Clause[] {
  const clauses = new Map<
    ClauseKind,
    { calls: number; paths: Set<string>; unnamed: number }
  >();
  for (const entry of items) {
    if (entry.type !== "tool_use") continue;
    const kind = clauseKind(entry);
    let clause = clauses.get(kind);
    if (!clause) {
      clause = { calls: 0, paths: new Set(), unnamed: 0 };
      clauses.set(kind, clause);
    }
    clause.calls++;
    if (kind === "file" || kind === "edit") {
      const paths = entryPaths(entry);
      if (paths.length) for (const path of paths) clause.paths.add(path);
      else clause.unnamed++;
    } else if (kind === "follow-up") {
      const id = followUpId(entry);
      if (id) clause.paths.add(id);
      else clause.unnamed++;
    }
  }
  return [...clauses].map(([kind, clause]) => ({
    kind,
    // Four passes over one file are one file edited. A call that names no
    // file still counts, so the clause is never "edited 0 files".
    count:
      kind === "file" || kind === "edit" || kind === "follow-up"
        ? clause.paths.size + clause.unnamed
        : clause.calls,
  }));
}

/**
 * The sentence, lower case so it can follow other text. An empty string when
 * the run made no tool calls.
 */
export function workSummary(items: readonly TranscriptEntry[]): string {
  return workSummaryClauses(items).map(clauseText).join(", ");
}

/** The same sentence standing on its own line. */
export function workSummaryTitle(items: readonly TranscriptEntry[]): string {
  const summary = workSummary(items);
  return summary ? summary[0].toUpperCase() + summary.slice(1) : "";
}
