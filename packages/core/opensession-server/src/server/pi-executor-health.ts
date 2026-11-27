import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { freemem, totalmem } from "node:os";

/**
 * Host/sandbox executor health detection for tool execution.
 *
 * Detects OOM kills (exit 137 / heap exhaustion), disk-full errors (ENOSPC),
 * and severe host memory pressure during failing shell/file tool calls.
 * Appends a structured `<executor_health>` diagnostic to the tool output so
 * the model doesn't blindly retry a resource-starved command, and notifies
 * the caller so a single warn-tone notice can be recorded in the transcript.
 */

export type ExecutorHealthKind = "oom" | "disk-full" | "memory-pressure";

export interface ExecutorHealthWarning {
  readonly kind: ExecutorHealthKind;
  readonly summary: string;
  readonly guidance: string;
}

const OOM_PATTERNS = [
  /\bexit(?:ed with)?(?: code| status)?[:=\s]+137\b/i,
  /\bsigkill\b/i,
  /\bout of memory\b/i,
  /\boom[- ]?killer\b/i,
  /\bcannot allocate memory\b/i,
  /\bjavascript heap out of memory\b/i,
  /\bfatal error:\s*reached heap limit\b/i,
  /\ballocation failed\b.*\bmemory\b/i,
  /\benomem\b/i,
];

const DISK_FULL_PATTERNS = [
  /\benospc\b/i,
  /\bno space left on device\b/i,
  /\bdisk quota exceeded\b/i,
];

export interface HealthDetectOptions {
  readonly exitCode?: number;
  /** Ratio of free host memory (0..1). Optional override for deterministic tests. */
  readonly freeMemRatio?: number;
  /** Whether the tool call threw or reported an error. */
  readonly failed?: boolean;
}

export function detectExecutorHealthWarning(
  text: string,
  opts: HealthDetectOptions = {},
): ExecutorHealthWarning | null {
  if (DISK_FULL_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: "disk-full",
      summary: "Executor health: disk full (ENOSPC)",
      guidance:
        "The host or sandbox filesystem ran out of space. Free temporary artifacts/build caches or narrow the operation before retrying.",
    };
  }

  if (opts.exitCode === 137 || OOM_PATTERNS.some((re) => re.test(text))) {
    return {
      kind: "oom",
      summary:
        "Executor health: process killed or out of memory (exit 137 / OOM)",
      guidance:
        "The process likely exceeded available memory (SIGKILL / OOM). Reduce concurrency (e.g. fewer parallel workers/jobs) or run a smaller scope instead of retrying unchanged.",
    };
  }

  if (opts.failed) {
    const ratio =
      opts.freeMemRatio ??
      (() => {
        const total = totalmem();
        return total > 0 ? freemem() / total : 1;
      })();
    if (ratio <= 0.04) {
      const pctFree = Math.max(0, Math.round(ratio * 100));
      return {
        kind: "memory-pressure",
        summary: `Executor health: host memory critically low (${pctFree}% free)`,
        guidance:
          "Available memory is critically low. Avoid parallel builds or heavy test suites until memory recovers.",
      };
    }
  }

  return null;
}

export function formatExecutorHealthTag(
  warning: ExecutorHealthWarning,
): string {
  return `<executor_health kind="${warning.kind}">\n${warning.summary}. ${warning.guidance}\n</executor_health>`;
}

const WATCHED_TOOLS = new Set([
  "bash",
  "bash_status",
  "write",
  "edit",
  "apply_patch",
]);

function extractResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        Boolean(item) &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

export function piExecutorHealthTools(
  tools: readonly ToolDefinition<any, any, any>[],
  opts: {
    readonly onWarning?: (warning: ExecutorHealthWarning) => void;
    readonly freeMemRatio?: () => number;
  } = {},
): ToolDefinition<any, any, any>[] {
  const reportedKinds = new Set<ExecutorHealthKind>();
  const reportOnce = (warning: ExecutorHealthWarning) => {
    if (reportedKinds.has(warning.kind)) return;
    reportedKinds.add(warning.kind);
    opts.onWarning?.(warning);
  };

  return tools.map((tool) => {
    if (!WATCHED_TOOLS.has(tool.name)) return tool;
    return {
      ...tool,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        try {
          const result = await tool.execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx,
          );
          const text = extractResultText(result);
          const details =
            result && typeof result === "object"
              ? (result as { details?: { exitCode?: number } }).details
              : undefined;
          const warning = detectExecutorHealthWarning(text, {
            exitCode:
              typeof details?.exitCode === "number"
                ? details.exitCode
                : undefined,
            failed: false,
          });
          if (!warning) return result;
          reportOnce(warning);
          const block = {
            type: "text" as const,
            text: formatExecutorHealthTag(warning),
          };
          const content = Array.isArray(result.content)
            ? [...result.content, block]
            : [block];
          return { ...result, content };
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          const warning = detectExecutorHealthWarning(raw, {
            failed: true,
            freeMemRatio: opts.freeMemRatio?.(),
          });
          if (warning) {
            reportOnce(warning);
            const tag = formatExecutorHealthTag(warning);
            if (!raw.includes("<executor_health")) {
              const next = new Error(`${raw}\n\n${tag}`);
              if (err instanceof Error && err.stack) next.stack = err.stack;
              throw next;
            }
          }
          throw err;
        }
      },
    };
  });
}
