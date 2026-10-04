import { appendTranscriptEvents } from "./actor-transcript";
import { recordEngineSessionOwnerAsync } from "./transcript-persistence";
import {
  journalSetAsync,
  journalClearAsync,
  buildRunJournalRecord,
} from "./run-journal";
import { readEngineHandoffTranscriptAsync } from "./sessions";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { EngineCapabilities } from "@tellahq/opensession-protocol/engine";
import type { EngineAdapter } from "./engine-adapter";
import type { RunAgentOpts } from "./agent-runner";
import type { StreamEvent } from "./run-events";

/** Operator-owned configuration, never accepted from turn input. */
export interface AcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}
export interface AcpRunOptions extends RunAgentOpts {
  /** Already scoped by the caller's MCP allowlist and interactive policy. */
  acpMcpServers?: AcpMcpServer[];
}

type Json = Record<string, any>;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function acpCapabilities(
  initialize: Json = {},
): Readonly<EngineCapabilities> {
  const caps = initialize.agentCapabilities || {};
  return {
    version: 1,
    supportsSteering: false,
    supportsInterrupt: true,
    canResume: caps.loadSession === true,
    canRewindConversation: false,
    canForkNatively: false,
    supportsMcpTools: true,
    supportsImages: caps.promptCapabilities?.image === true,
    streamsReasoning: true,
    emitsToolOutput: true,
    terminalStatusQuality: "authoritative",
  };
}

/** Each turn owns its subprocess, outstanding RPCs and bounded event queue. */
class AcpConnection {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve(value: Json): void; reject(error: Error): void }
  >();
  private failure?: Error;
  private queue: StreamEvent[] = [];
  private bytes = 0;
  private wake?: () => void;
  private stopped = false;
  private stderr = "";
  private readonly lines;
  readonly exited: Promise<void>;

  constructor(
    config: AcpAgentConfig,
    cwd: string,
    private readonly update: (params: Json) => StreamEvent[],
    private readonly permission: (params: Json) => Json,
  ) {
    const env: Record<string, string> = {};
    for (const name of [
      "PATH",
      "HOME",
      "USER",
      "SHELL",
      "LANG",
      "TMPDIR",
      "SYSTEMROOT",
    ]) {
      if (process.env[name]) env[name] = process.env[name]!;
    }
    this.child = spawn(config.command, config.args || [], {
      cwd,
      env: { NODE_ENV: "production", ...env, ...config.env },
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    this.child.on("error", (error) =>
      this.fail(
        new Error(`ACP agent ${config.id} could not start: ${error.message}`),
      ),
    );
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4096);
    });
    this.exited = new Promise((resolve) =>
      this.child.once("close", (code) => {
        if (!this.stopped)
          this.fail(new Error(`ACP agent exited (${code}): ${this.stderr}`));
        resolve();
      }),
    );
    let lineBytes = 0;
    this.child.stdout.on("data", (data: Buffer) => {
      for (const byte of data) {
        lineBytes = byte === 10 ? 0 : lineBytes + 1;
        if (lineBytes > MAX_BUFFER_BYTES) {
          this.fail(new Error("ACP message exceeded size limit"));
          this.kill();
          break;
        }
      }
    });
    this.lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    this.lines.on("line", (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch {
        this.fail(new Error("ACP agent emitted invalid JSON-RPC"));
        this.kill();
      }
    });
  }
  private send(message: Json): void {
    if (this.failure) throw this.failure;
    if (
      !this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
      ) &&
      this.child.stdin.writableLength > MAX_BUFFER_BYTES
    )
      throw new Error("ACP input exceeded size limit");
  }
  private receive(message: Json): void {
    if (message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC version");
    if (message.method) {
      if (message.id !== undefined) {
        if (message.method === "session/request_permission")
          this.send({
            id: message.id,
            result: this.permission(message.params || {}),
          });
        else
          this.send({
            id: message.id,
            error: { code: -32601, message: "Client method not supported" },
          });
      } else if (message.method === "session/update") {
        for (const event of this.update(message.params || {})) this.push(event);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error)
      pending.reject(
        new Error(`ACP: ${message.error.message || "RPC failed"}`),
      );
    else pending.resolve(message.result || {});
  }
  request(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
      if (timeoutMs)
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} timed out`));
        }, timeoutMs);
    });
    return result.finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
  push(event: StreamEvent): void {
    this.bytes += JSON.stringify(event).length;
    if (this.bytes > MAX_BUFFER_BYTES) {
      this.fail(new Error("ACP event queue exceeded size limit"));
      this.kill();
      return;
    }
    this.queue.push(event);
    this.wake?.();
  }
  async next(): Promise<StreamEvent> {
    while (!this.queue.length) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
    const event = this.queue.shift()!;
    this.bytes -= JSON.stringify(event).length;
    return event;
  }
  fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    this.wake?.();
  }
  cancel(sessionId?: string): void {
    try {
      if (sessionId)
        this.send({ method: "session/cancel", params: { sessionId } });
    } catch {
      /* Already exited. */
    }
    this.fail(new Error("ACP turn cancelled"));
    this.kill();
  }
  kill(): void {
    this.stopped = true;
    this.lines.close();
    try {
      if (process.platform !== "win32" && this.child.pid)
        process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch {
      /* Already exited. */
    }
    this.fail(new Error("ACP connection closed"));
  }
}

export function acpUpdateEvents(params: Json): StreamEvent[] {
  const update = params.update || {};
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content?.type === "text"
        ? [{ type: "text_chunk", text: update.content.text }]
        : [];
    case "agent_thought_chunk":
      return update.content?.type === "text"
        ? [{ type: "text_chunk", text: update.content.text, isReasoning: true }]
        : [];
    case "tool_call":
      return [
        {
          type: "tool_use",
          toolUseId: update.toolCallId,
          toolName: update.title || update.kind || "Tool",
          toolInput: update.rawInput,
        },
      ];
    case "tool_call_update":
      if (
        update.status !== "completed" &&
        update.status !== "failed" &&
        !update.content?.length &&
        update.rawOutput === undefined
      )
        return [];
      return [
        ...(update.rawInput !== undefined
          ? [
              {
                type: "tool_use" as const,
                toolUseId: update.toolCallId,
                toolName: update.title || "Tool",
                toolInput: update.rawInput,
              },
            ]
          : []),
        {
          type: "tool_result",
          toolUseId: update.toolCallId,
          isError: update.status === "failed",
          images: (update.content || []).flatMap((item: Json) =>
            item.type === "content" && item.content?.type === "image"
              ? [`data:${item.content.mimeType};base64,${item.content.data}`]
              : [],
          ),
          content:
            (update.content || [])
              .flatMap((item: Json) =>
                item.type === "content" && item.content?.type === "text"
                  ? [item.content.text]
                  : [JSON.stringify(item)],
              )
              .join("\n") || JSON.stringify(update.rawOutput ?? ""),
        },
      ];
    case "plan":
      return [
        {
          type: "runner_notice",
          text: (update.entries || [])
            .map((entry: Json) => `${entry.status}: ${entry.content}`)
            .join("\n"),
        },
      ];
    default:
      return [];
  }
}

/** Negotiated capabilities and aliases belong to a configured instance.
 * Creating this adapter has no process or timer side effects. */
export function createAcpAdapter(config: AcpAgentConfig): EngineAdapter {
  const active = new Map<
    string,
    { connection: AcpConnection; sessionId?: string }
  >();
  let capabilities = acpCapabilities();
  return {
    kind: "acp",
    get capabilities() {
      return capabilities;
    },
    busy: (id) => active.has(id),
    activeCount: () => new Set(active.values()).size,
    steer: () => false,
    retract: () => false,
    cancel(id) {
      const handle = active.get(id);
      if (!handle) return false;
      handle.connection.cancel(handle.sessionId);
      return true;
    },
    async *run(
      opts: AcpRunOptions,
      model: string,
    ): AsyncGenerator<StreamEvent> {
      // Agent-owned tools cannot enforce these policies. Refuse, never weaken.
      if (
        opts.mcpServers === "all" ||
        opts.remoteWorkspace ||
        opts.disableLocalWorkspaceTools ||
        opts.mode === "ask" ||
        Object.keys(opts.deniedTools || {}).length ||
        Object.keys(opts.confirmTools || {}).length ||
        opts.publicationPolicy ||
        opts.inProcessMcp ||
        (Array.isArray(opts.mcpServers) &&
          opts.mcpServers.length &&
          !opts.acpMcpServers)
      ) {
        yield {
          type: "error",
          content: "ACP does not support this run's workspace or tool policy.",
        };
        return;
      }
      const key = opts.startToken || opts.sessionId || crypto.randomUUID();
      if (active.has(key)) {
        yield { type: "error", content: "ACP session is already running." };
        return;
      }
      let text = "";
      let engineId: string | undefined;
      let turnPrompt = opts.prompt;
      let streaming = false;
      const toolNames = new Map<string, string>();
      let sessionId: string | undefined;
      const connection = new AcpConnection(
        config,
        opts.cwd,
        (params) => {
          // session/load replays history. Only new prompt updates are live output.
          if (!streaming || params.sessionId !== sessionId) return [];
          const events = acpUpdateEvents(params);
          for (const event of events) {
            if (event.toolUseId) {
              const rawId = event.toolUseId;
              if (event.type === "tool_use" && event.toolName !== "Tool")
                toolNames.set(rawId, event.toolName || "Tool");
              event.toolName = toolNames.get(rawId) || event.toolName;
              if (opts.journal?.osSessionId)
                event.toolUseId = `${key}:${rawId}`;
            }
          }
          for (const event of events)
            if (event.type === "text_chunk" && !event.isReasoning)
              text += event.text;
          return events;
        },
        (params) => {
          // Only one-time approval in already unrestricted code/scratch modes.
          if (params.sessionId !== sessionId)
            return { outcome: { outcome: "cancelled" } };
          const option = (params.options || []).find(
            (option: Json) => option.kind === "allow_once",
          );
          return {
            outcome:
              option &&
              (!opts.mode || opts.mode === "code" || opts.mode === "scratch")
                ? { outcome: "selected", optionId: option.optionId }
                : { outcome: "cancelled" },
          };
        },
      );
      const handle = { connection, sessionId };
      active.set(key, handle);
      try {
        if (opts.journal?.osSessionId)
          await journalSetAsync(
            buildRunJournalRecord(opts, {
              runKey: key,
              osSessionId: opts.journal.osSessionId,
              cwd: opts.cwd,
              prompt: opts.prompt,
              model,
            }),
          );
        const initialized = await connection.request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "opensession", version: "1" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        });
        if (initialized.protocolVersion !== 1)
          throw new Error("ACP agent did not negotiate protocol version 1");
        capabilities = acpCapabilities(initialized);
        const params = { cwd: opts.cwd, mcpServers: opts.acpMcpServers || [] };
        const prefix = `acp:${config.id}:`;
        const stored = opts.sessionId?.startsWith("acp:")
          ? opts.sessionId.startsWith(prefix)
            ? opts.sessionId.slice(prefix.length)
            : undefined
          : opts.sessionId;
        if (stored && capabilities.canResume) {
          await connection.request("session/load", {
            ...params,
            sessionId: stored,
          });
          sessionId = stored;
        } else {
          if (stored && !capabilities.canResume) {
            if (!opts.journal?.osSessionId)
              throw new Error(
                "ACP agent does not support loading stored sessions",
              );
            await recordEngineSessionOwnerAsync(
              opts.sessionId!,
              opts.journal.osSessionId,
            );
            const history = await readEngineHandoffTranscriptAsync(
              opts.cwd,
              opts.sessionId!,
              "acp",
            );
            if (history.length)
              turnPrompt = `${buildEngineSwitchHandoffNote({
                entries: history.filter(
                  (entry) => entry.id !== opts.promptEntryId,
                ),
                targetModel: model,
                sessionId: opts.journal.osSessionId,
                reservedBytes: new TextEncoder().encode(turnPrompt).length,
                fromModel: model,
                fromProvider: "acp",
                toProvider: "acp",
                sameEngineRestart: true,
              })}}\n\n${turnPrompt}`;
          }
          const created = await connection.request("session/new", params);
          if (typeof created.sessionId !== "string" || !created.sessionId)
            throw new Error("ACP agent returned no session id");
          sessionId = created.sessionId;
        }
        engineId = `${prefix}${sessionId}`;
        if (opts.journal?.osSessionId) {
          await recordEngineSessionOwnerAsync(
            engineId,
            opts.journal.osSessionId,
          );
          await journalSetAsync(
            buildRunJournalRecord(opts, {
              runKey: key,
              osSessionId: opts.journal.osSessionId,
              cwd: opts.cwd,
              prompt: opts.prompt,
              model,
              claudeSessionId: engineId,
            }),
          );
        }
        handle.sessionId = sessionId;
        if (active.has(engineId) && active.get(engineId) !== handle)
          throw new Error("ACP session is already running");
        active.set(engineId, handle);
        yield {
          type: "init",
          sessionId: engineId,
          provider: "acp",
          model,
          engineKind: "acp",
          engineInstanceId: config.id,
          engineCapabilities: capabilities,
        };
        if (opts.shouldCancel?.()) throw new Error("ACP turn cancelled");
        const prompt: Json[] = [{ type: "text", text: turnPrompt }];
        if (opts.images?.length && !capabilities.supportsImages)
          throw new Error("ACP agent does not support images");
        for (const image of opts.images || [])
          prompt.push({
            type: "image",
            data: image.data,
            mimeType: image.mediaType,
          });
        streaming = true;
        void connection
          .request("session/prompt", { sessionId, prompt }, 0)
          .then(
            (result) => {
              if (result.stopReason === "end_turn")
                connection.push({
                  type: "done",
                  sessionId: engineId,
                  provider: "acp",
                  model,
                  result: text,
                });
              else
                connection.push({
                  type: "error",
                  sessionId: engineId,
                  provider: "acp",
                  content: `ACP turn stopped: ${result.stopReason || "unknown"}`,
                });
              connection.kill();
            },
            (error) => {
              connection.fail(error);
              connection.kill();
            },
          );
        while (true) {
          const event = await connection.next();
          if (
            opts.journal?.osSessionId &&
            ["text_chunk", "tool_use", "tool_result", "runner_notice"].includes(
              event.type,
            )
          ) {
            const id = event.toolUseId
              ? `${event.type}:${event.toolUseId}`
              : event.blockId || crypto.randomUUID();
            if (event.type === "text_chunk") event.blockId = id;
            await appendTranscriptEvents(opts.journal.osSessionId, [
              {
                id,
                type:
                  event.type === "text_chunk"
                    ? "assistant"
                    : event.type === "runner_notice"
                      ? "system"
                      : (event.type as "tool_use" | "tool_result"),
                content:
                  event.type === "text_chunk" || event.type === "runner_notice"
                    ? event.text || ""
                    : event.content || "",
                timestamp: new Date().toISOString(),
                model,
                isReasoning: event.isReasoning,
                isError: event.isError,
                images: event.images,
                toolName: event.toolName,
                toolInput: event.toolInput,
                toolUseId: event.toolUseId,
              },
            ]);
          }
          yield event;
          if (event.type === "done" || event.type === "error") break;
        }
      } catch (error) {
        connection.kill();
        await connection.exited;
        yield {
          type: "error",
          sessionId: engineId,
          provider: "acp",
          content: error instanceof Error ? error.message : String(error),
        };
      } finally {
        for (const [alias, value] of active)
          if (value === handle) active.delete(alias);
        connection.kill();
        await connection.exited;
        if (opts.journal?.osSessionId) await journalClearAsync(key);
      }
    },
  };
}
