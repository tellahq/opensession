/**
 * One Claude Agent SDK streaming-input query, described by plain data.
 *
 * The pi Anthropic provider (pi-model-runtime.ts) keeps one such query alive
 * per conversation. Everything the provider decides (model, system prompt,
 * client tools, resume point, thinking, credentials) is in `ClaudeQuerySpec`;
 * everything that flows while the query runs (user input, SDK messages, client
 * tool calls and their results) goes through `ClaudeQueryIo` and the returned
 * handle. That split is what lets the same query run in this process
 * (`startLocalClaudeQuery`) or in a separate Claude host service that this
 * process reaches over a socket (claude-host-client.ts).
 *
 * A leaf module: no account pool, audit log, or config import. The caller
 * supplies the paths and the spawn function.
 */

import {
  query,
  createSdkMcpServer,
  tool,
  type EffortLevel,
  type Options,
  type SDKUserMessage,
  type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import {
  DISALLOWED_BUILTINS,
  PASSTHROUGH_MCP,
  PASSTHROUGH_PREFIX,
  SDK_BUILTIN_TOOLS,
  jsonSchemaToZodShape,
} from "./claude-passthrough-tools";

/** How long Claude Code waits for a client tool before giving up on it. The
 *  provider retires an abandoned tool turn long before this. */
export const CLAUDE_QUERY_TOOL_TIMEOUT_MS = 24 * 60 * 60_000;

export interface ClaudeToolDefinition {
  name: string;
  description: string;
  parameters?: unknown;
}

export type ClaudeToolReply = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

/** Everything that fixes a query for its lifetime. JSON-serializable. */
export interface ClaudeQuerySpec {
  /** Selects the isolated Claude Code config directory holding this
   *  conversation's SDK session files. */
  accountId: string;
  model: string;
  system: string;
  tools: ClaudeToolDefinition[];
  resume?: string;
  resumeSessionAt?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  /** Credential and Claude Code tuning variables for the process. */
  env: Record<string, string>;
}

export interface ClaudeQueryIo {
  /** User messages for the query; it ends when this iterable ends. */
  prompt: AsyncIterable<SDKUserMessage>;
  abortController: AbortController;
  /** Claude called a client tool: resolve with its result once known. */
  onToolCall: (toolUseId: string) => Promise<ClaudeToolReply>;
}

/** The part of the SDK's Query the provider uses. */
export interface ClaudeQueryHandle {
  next(): Promise<IteratorResult<Record<string, any>>>;
  close(): void;
}

/** Where and how this process runs Claude Code. */
export interface ClaudeQueryRuntime {
  claudeBin: string;
  cwd: string;
  configDir: (accountId: string) => string;
  spawn: NonNullable<Options["spawnClaudeCodeProcess"]>;
}

/** The input side of a streaming-input query: push user messages as they
 *  arrive, close to let the query end. */
export class ClaudeInputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #items: SDKUserMessage[] = [];
  readonly #waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> =
    [];
  #closed = false;

  push(message: SDKUserMessage): void {
    if (this.#closed) throw new Error("Claude SDK input is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.#items.push(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.#items.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function sdkToolUseId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const metadata = (extra as { _meta?: unknown })._meta;
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)["claudecode/toolUseId"];
  return typeof value === "string" && value ? value : undefined;
}

/** Start the query in this process. The Claude Code child gets only the
 *  listed environment, never this process's own. */
export function startLocalClaudeQuery(
  spec: ClaudeQuerySpec,
  io: ClaudeQueryIo,
  runtime: ClaudeQueryRuntime,
): ClaudeQueryHandle {
  const passthroughTools = spec.tools.map((definition) =>
    tool(
      definition.name,
      definition.description || definition.name,
      jsonSchemaToZodShape(definition.parameters),
      async (_arguments, extra) => {
        const toolUseId = sdkToolUseId(extra);
        if (!toolUseId) {
          return {
            content: [
              { type: "text" as const, text: "Missing Claude tool call id" },
            ],
            isError: true,
          };
        }
        return io.onToolCall(toolUseId);
      },
    ),
  );
  const mcpServers = passthroughTools.length
    ? {
        [PASSTHROUGH_MCP]: createSdkMcpServer({
          name: PASSTHROUGH_MCP,
          tools: passthroughTools,
        }),
      }
    : {};
  return query({
    prompt: io.prompt,
    options: {
      cwd: runtime.cwd,
      model: spec.model,
      resume: spec.resume,
      ...(spec.resumeSessionAt
        ? { resumeSessionAt: spec.resumeSessionAt }
        : {}),
      abortController: io.abortController,
      includePartialMessages: true,
      ...(spec.thinking ? { thinking: spec.thinking } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      systemPrompt: spec.system || " ",
      settingSources: [],
      mcpServers: mcpServers as any,
      strictMcpConfig: true,
      tools: SDK_BUILTIN_TOOLS,
      disallowedTools: DISALLOWED_BUILTINS,
      allowedTools: spec.tools.map(
        (definition) => `${PASSTHROUGH_PREFIX}${definition.name}`,
      ),
      pathToClaudeCodeExecutable: runtime.claudeBin,
      executable: "bun" as const,
      spawnClaudeCodeProcess: runtime.spawn,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        ...spec.env,
        CLAUDE_CONFIG_DIR: runtime.configDir(spec.accountId),
        MCP_TOOL_TIMEOUT: String(CLAUDE_QUERY_TOOL_TIMEOUT_MS),
      },
    },
  }) as unknown as ClaudeQueryHandle;
}
