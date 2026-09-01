import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseTranscriptAsync } from "./jsonl-parser";
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

function readMeta(dir: string, agentId: string): SubagentMeta {
  const metaPath = join(dir, `agent-${agentId}.meta.json`);
  if (existsSync(metaPath)) {
    try {
      const m = JSON.parse(readFileSync(metaPath, "utf-8"));
      return {
        agentId,
        agentType: m.agentType,
        model: typeof m.model === "string" ? m.model : undefined,
        description: m.description,
        toolUseId: m.toolUseId,
        spawnDepth: m.spawnDepth,
      };
    } catch {
      // fall through to the bare id
    }
  }
  return { agentId };
}

/** List every sub-agent spawned under a session, newest meta first is not
 *  guaranteed — callers sort as needed. */
export function listSubagents(transcriptPath: string): SubagentMeta[] {
  const dir = subagentsDir(transcriptPath);
  if (!dir || !existsSync(dir)) return [];
  const out: SubagentMeta[] = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(/^agent-(.+)\.jsonl$/);
    if (!m) continue;
    out.push(readMeta(dir, m[1]));
  }
  return out;
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
  if (!existsSync(file)) return null;
  return {
    meta: readMeta(dir, agentId),
    entries: await parseTranscriptAsync(file),
  };
}

/** Absolute path to a sub-agent's transcript file (for live file-watching). */
export function subagentTranscriptPath(
  transcriptPath: string,
  agentId: string,
): string | null {
  const dir = subagentsDir(transcriptPath);
  if (!dir) return null;
  const file = join(dir, `agent-${agentId}.jsonl`);
  return existsSync(file) ? file : null;
}
