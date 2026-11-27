/**
 * Candid, practical engineering notes shown in the model picker so people can
 * pick the right model for a task without guessing from bare version numbers.
 */

export interface ModelGuidance {
  readonly summary: string;
  readonly strongAt: readonly string[];
  readonly watchFor: readonly string[];
}

interface GuidanceRule {
  readonly match: RegExp;
  readonly guidance: ModelGuidance;
}

const RULES: readonly GuidanceRule[] = [
  {
    match: /^claude-fable\b/i,
    guidance: {
      summary: "Hardest open-ended builds",
      strongAt: [
        "Hard open-ended architecture and long autonomous builds",
        "End-to-end feature work with strong design taste",
      ],
      watchFor: [
        "Highest cost and latency; Opus fits most everyday tasks better",
      ],
    },
  },
  {
    match: /^claude-mythos\b/i,
    guidance: {
      summary: "Security research & deep audits",
      strongAt: ["Authorized security research and complex static analysis"],
      watchFor: ["Requires verified org access and carries flagship cost"],
    },
  },
  {
    match: /^claude-opus\b/i,
    guidance: {
      summary: "Feature work & front-end taste",
      strongAt: [
        "Shipping end-to-end features with minimal steering",
        "Front-end craft, UI polish, and clear written summaries",
      ],
      watchFor: [
        "Max effort can over-think simple tasks",
        "Cost when fanning out many sub-sessions",
      ],
    },
  },
  {
    match: /^claude-sonnet\b/i,
    guidance: {
      summary: "Fast planned implementation",
      strongAt: [
        "Implementing clear specs quickly at lower cost",
        "Worker tasks and well-scoped refactors",
      ],
      watchFor: ["Softer front-end taste than Opus on ambiguous UI"],
    },
  },
  {
    match: /^claude-haiku\b/i,
    guidance: {
      summary: "Quick scoped edits & helpers",
      strongAt: ["Fast, cheap scoped edits and lightweight sub-tasks"],
      watchFor: ["Multi-file reasoning or open-ended debugging"],
    },
  },
  {
    match: /^gpt-[\d.]+-astra\b|^gpt-5(?:\.\d+)?-pro\b/i,
    guidance: {
      summary: "Deep debugging, audits & perf",
      strongAt: [
        "Hard cross-service bugs, root-cause analysis, and perf work",
        "Native Codex apply_patch edits and deep code audits",
      ],
      watchFor: [
        "Can over-engineer or run past the ask without clear bounds",
        "Verify completion claims; UI design taste trails Opus",
      ],
    },
  },
  {
    match: /^gpt-[\d.]+-sol\b|^gpt-5(?:\.\d+)?(?:-codex)?$/i,
    guidance: {
      summary: "Everyday coding & root-causing",
      strongAt: [
        "Fast everyday coding, code review, and bug diagnosis",
        "Native Codex apply_patch edits with crisp diffs",
      ],
      watchFor: ["UI design taste below Opus; check long unattended builds"],
    },
  },
  {
    match: /^gpt-[\d.]+-terra\b|^gpt-5(?:\.\d+)?-mini\b/i,
    guidance: {
      summary: "Small well-defined changes",
      strongAt: ["Fast, low-cost execution on clear, bounded edits"],
      watchFor: ["Open-ended architecture or nuanced UI work"],
    },
  },
  {
    match: /^gpt-[\d.]+-luna\b|^gpt-5(?:\.\d+)?-nano\b/i,
    guidance: {
      summary: "Cheap SQL & tiny edits",
      strongAt: ["Quick SQL queries, scripts, and single-file tweaks"],
      watchFor: ["Multi-step debugging or large refactors"],
    },
  },
  {
    match: /^gemini-[\d.]+-carbon\b|^gemini-[\d.]+-pro\b/i,
    guidance: {
      summary: "Large-context hard builds",
      strongAt: [
        "Very large context windows, visual inspection, and architecture",
      ],
      watchFor: ["Slower loops; double-check confident codebase claims"],
    },
  },
  {
    match: /^gemini-[\d.]+-(?:neon|hydrogen)\b/i,
    guidance: {
      summary: "Fast everyday repo debugging",
      strongAt: ["Quick iteration across large files and tool-heavy loops"],
      watchFor: ["Oversized diffs on loosely specified prompts"],
    },
  },
  {
    match: /^gemini-[\d.]+-flash\b/i,
    guidance: {
      summary: "Fast prototypes & triage",
      strongAt: ["Cheap, rapid HTML/JS prototypes and fast triage"],
      watchFor: ["Long multi-step editing loops"],
    },
  },
  {
    match: /^grok-/i,
    guidance: {
      summary: "Thorough self-checking review",
      strongAt: ["Thorough code reviews and terminal-heavy workflows"],
      watchFor: ["Higher token spend and weaker front-end design"],
    },
  },
  {
    match: /^glm-/i,
    guidance: {
      summary: "Low-cost scoped backend work",
      strongAt: ["Clear, scoped backend edits at low cost"],
      watchFor: ["Ambiguous tasks or heavy multi-tool setups"],
    },
  },
  {
    match: /^deepseek-/i,
    guidance: {
      summary: "Cheap scoped worker tasks",
      strongAt: ["Well-specified, self-contained edits at low cost"],
      watchFor: ["Higher run-to-run variance on open-ended work"],
    },
  },
  {
    match: /^kimi-/i,
    guidance: {
      summary: "Readable UI & large context",
      strongAt: ["Readable code, UI builds, and large context windows"],
      watchFor: ["Higher token usage and latency"],
    },
  },
];

export function modelGuidanceFor(modelId: string): ModelGuidance | null {
  const tail = (modelId.split("/").pop() || modelId).trim();
  if (!tail) return null;
  for (const rule of RULES) {
    if (rule.match.test(tail)) return rule.guidance;
  }
  return null;
}

export function formatModelGuidanceTitle(guidance: ModelGuidance): string {
  const lines = [guidance.summary];
  if (guidance.strongAt.length > 0) {
    lines.push(`Strong at: ${guidance.strongAt.join("; ")}`);
  }
  if (guidance.watchFor.length > 0) {
    lines.push(`Watch for: ${guidance.watchFor.join("; ")}`);
  }
  return lines.join("\n");
}
