import { readdir, readFile } from "node:fs/promises";
import { join } from "path";
import { parseTranscriptAsync } from "./jsonl-parser";
import { pathExists } from "./run-fs";
import type { TranscriptEntry } from "./types";

// When a session spawns sub-agents (Task/Agent tool), the Claude Agent SDK writes
// each sub-agent's own conversation to a sibling directory next to the parent
// transcript:
//
//   <project>/<sessionUuid>.jsonl              ← parent transcript
//   <project>/<sessionUuid>/subagents/         ← one pair per sub-agent:
//     agent-<agentId>.jsonl                       its transcript (same schema)
//     agent-<agentId>.meta.json                   { agentType, description, toolUseId, spawnDepth }
//
// The agentId links a Task tool_result (its toolUseResult.agentId, surfaced on
// the parsed entry) to the sub-agent's transcript. Sub-agents can themselves
// spawn sub-agents, so a nested agent's files live under ITS OWN subagents dir;
// all of them share one flat `subagents/` folder keyed by agentId, so a lookup
// by agentId works regardless of depth.

export interface SubagentMeta {
  agentId: string;
  agentType?: string;
  model?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

export interface SubagentTranscript {
  meta: SubagentMeta;
  entries: TranscriptEntry[];
}

/** The `subagents/` directory for a parent transcript path, or null for Codex
 *  rollouts (which don't use this layout). */
function subagentsDir(transcriptPath: string): string | null {
  if (!transcriptPath.endsWith(".jsonl")) return null;
  return transcriptPath.replace(/\.jsonl$/, "") + "/subagents";
}

async function readMeta(dir: string, agentId: string): Promise<SubagentMeta> {
  const metaPath = join(dir, `agent-${agentId}.meta.json`);
  try {
    const m = JSON.parse(await readFile(metaPath, "utf-8"));
    return {
      agentId,
      agentType: m.agentType,
      model: typeof m.model === "string" ? m.model : undefined,
      description: m.description,
      toolUseId: m.toolUseId,
      spawnDepth: m.spawnDepth,
    };
  } catch {
    // Missing or unreadable: fall back to the bare id.
    return { agentId };
  }
}

/** List every sub-agent spawned under a session, newest meta first is not
 *  guaranteed — callers sort as needed. */
export async function listSubagents(
  transcriptPath: string,
): Promise<SubagentMeta[]> {
  const dir = subagentsDir(transcriptPath);
  if (!dir) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const ids = names.flatMap(
    (name) => name.match(/^agent-(.+)\.jsonl$/)?.slice(1, 2) ?? [],
  );
  return Promise.all(ids.map((id) => readMeta(dir, id)));
}

/** Load a single sub-agent's conversation (meta + parsed transcript), or null if
 *  its transcript file doesn't exist. Async: a sub-agent transcript can be
 *  multi-MB and the sync parse held the event loop for the whole read. */
export async function getSubagentTranscript(
  transcriptPath: string,
  agentId: string,
): Promise<SubagentTranscript | null> {
  const dir = subagentsDir(transcriptPath);
  if (!dir) return null;
  const file = join(dir, `agent-${agentId}.jsonl`);
  if (!(await pathExists(file))) return null;
  return {
    meta: await readMeta(dir, agentId),
    entries: await parseTranscriptAsync(file),
  };
}

/** Absolute path to a sub-agent's transcript file (for live file-watching). */
export async function subagentTranscriptPath(
  transcriptPath: string,
  agentId: string,
): Promise<string | null> {
  const dir = subagentsDir(transcriptPath);
  if (!dir) return null;
  const file = join(dir, `agent-${agentId}.jsonl`);
  return (await pathExists(file)) ? file : null;
}
