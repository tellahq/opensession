import type {
  ContextBreakdown,
  ContextSection,
} from "@tellahq/opensession-protocol/events";

/**
 * When a conversation is compacted, and what its context is made of.
 *
 * Pi compacts when the prompt comes within `reserveTokens` of the model's
 * window. With its default reserve (16,384) a 1M-token model runs to about
 * 98% full before anything is summarized: every request by then re-sends
 * close to a million tokens, and models attend less well to the middle of a
 * prompt that long. So a large window is compacted at a fixed size instead.
 * Smaller windows keep pi's default, because a session's fixed payload
 * (system prompt, tool schemas) is large enough that lowering their ceiling
 * risks compacting on every turn.
 */
export const COMPACT_AT_TOKENS = 440_000;

/** Pi's own default reserve (DEFAULT_COMPACTION_SETTINGS.reserveTokens). */
const PI_RESERVE_TOKENS = 16_384;

/** Prompt size at which pi compacts a model with this window. 0 = unknown. */
export function compactionThresholdTokens(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.max(
    0,
    Math.min(Math.floor(contextWindow) - PI_RESERVE_TOKENS, COMPACT_AT_TOKENS),
  );
}

/**
 * The `compaction.reserveTokens` setting that makes pi compact at
 * compactionThresholdTokens, or undefined when pi's default already does.
 */
export function piCompactionReserveTokens(
  contextWindow: number,
): number | undefined {
  const threshold = compactionThresholdTokens(contextWindow);
  if (threshold <= 0) return undefined;
  const reserve = Math.floor(contextWindow) - threshold;
  return reserve > PI_RESERVE_TOKENS ? reserve : undefined;
}

/** Pi's own heuristic (compaction.js estimateTokens): four characters a token. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface FixedContextInput {
  /** The complete system prompt as sent. */
  systemPrompt: string;
  /** Contents of the AGENTS.md and local instruction files in that prompt. */
  instructionFiles: readonly string[];
  /** The skills listed in that prompt. */
  skills: ReadonlyArray<{
    name: string;
    description?: string;
    filePath?: string;
  }>;
  /** Tool declarations as sent. */
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    parameters?: unknown;
  }>;
  /** True for a declaration that exists to reach MCP servers. */
  isMcpTool: (name: string) => boolean;
}

/** The part of every request that does not depend on the conversation. */
export interface FixedContext {
  systemPrompt: number;
  instructions: number;
  skills: number;
  tools: number;
  mcpTools: number;
}

// One skill's row in the prompt beyond its own text: the tags around its
// name, description and location.
const SKILL_ROW_OVERHEAD_CHARS = 60;

export function estimateFixedContext(input: FixedContextInput): FixedContext {
  const instructions = input.instructionFiles.reduce(
    (sum, content) => sum + estimateTextTokens(content),
    0,
  );
  const skills = input.skills.reduce(
    (sum, skill) =>
      sum +
      Math.ceil(
        (skill.name.length +
          (skill.description?.length ?? 0) +
          (skill.filePath?.length ?? 0) +
          SKILL_ROW_OVERHEAD_CHARS) /
          4,
      ),
    0,
  );
  let tools = 0;
  let mcpTools = 0;
  for (const tool of input.tools) {
    const tokens = estimateTextTokens(
      JSON.stringify({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? {},
      }),
    );
    if (input.isMcpTool(tool.name)) mcpTools += tokens;
    else tools += tokens;
  }
  // Instruction files and the skill list are part of the system prompt text;
  // what remains is the prompt nobody in the session wrote.
  const systemPrompt = Math.max(
    0,
    estimateTextTokens(input.systemPrompt) - instructions - skills,
  );
  return { systemPrompt, instructions, skills, tools, mcpTools };
}

/**
 * Split a provider-reported prompt size into sections. The fixed parts are
 * estimates, so when they overshoot the real total they are scaled down
 * together: the sections always sum to `contextTokens`, and `messages` is
 * never negative.
 */
export function contextBreakdown(input: {
  fixed: FixedContext;
  contextTokens: number;
  /** Text of the compaction summary now standing in for older messages. */
  summaryChars?: number;
  compactions?: number;
  contextWindow?: number;
}): ContextBreakdown | undefined {
  const total = Math.floor(input.contextTokens);
  if (!Number.isFinite(total) || total <= 0) return undefined;
  const estimated: ContextSection[] = [
    { kind: "system-prompt", tokens: input.fixed.systemPrompt },
    { kind: "instructions", tokens: input.fixed.instructions },
    { kind: "tools", tokens: input.fixed.tools },
    { kind: "mcp-tools", tokens: input.fixed.mcpTools },
    { kind: "skills", tokens: input.fixed.skills },
    { kind: "summary", tokens: Math.ceil((input.summaryChars ?? 0) / 4) },
  ];
  const estimatedTotal = estimated.reduce((sum, s) => sum + s.tokens, 0);
  const scale = estimatedTotal > total ? total / estimatedTotal : 1;
  const sections = estimated
    .map((section) => ({
      kind: section.kind,
      tokens: Math.floor(section.tokens * scale),
    }))
    .filter((section) => section.tokens > 0);
  const used = sections.reduce((sum, s) => sum + s.tokens, 0);
  if (total - used > 0)
    sections.push({ kind: "messages", tokens: total - used });
  const compactAtTokens = compactionThresholdTokens(input.contextWindow ?? 0);
  return {
    sections,
    ...(compactAtTokens > 0 ? { compactAtTokens } : {}),
    ...(input.compactions ? { compactions: input.compactions } : {}),
  };
}
