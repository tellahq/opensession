import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { serverErrorEnvelope } from "./errors";

export interface ChatCompletionMetadata {
  readonly id: string;
  readonly created: number;
  readonly model: string;
}

export interface ChatCompletionUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export type ChatFinishReason = "stop" | "length" | "tool_calls";

interface WireToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatCompletion {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly [
    {
      readonly index: 0;
      readonly message: {
        readonly role: "assistant";
        readonly content: string | null;
        readonly tool_calls?: readonly WireToolCall[];
      };
      readonly finish_reason: ChatFinishReason;
    },
  ];
  readonly usage: ChatCompletionUsage;
}

interface ChatCompletionChunk {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: 0;
    readonly delta: {
      readonly role?: "assistant";
      readonly content?: string;
      readonly tool_calls?: readonly {
        readonly index: number;
        readonly id?: string;
        readonly type?: "function";
        readonly function?: {
          readonly name?: string;
          readonly arguments?: string;
        };
      }[];
    };
    readonly finish_reason: ChatFinishReason | null;
  }[];
  readonly usage?: ChatCompletionUsage | null;
}

export function chatCompletionMetadata(input: {
  readonly model: string;
  readonly id?: string;
  readonly now?: number;
}): ChatCompletionMetadata {
  return {
    id: input.id ?? `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor((input.now ?? Date.now()) / 1_000),
    model: input.model,
  };
}

function finishReason(message: AssistantMessage): ChatFinishReason {
  switch (message.stopReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "toolUse":
      return "tool_calls";
    case "pending":
    case "deferred":
    case "error":
    case "aborted":
      throw new Error(
        `Cannot serialize assistant stop reason ${message.stopReason}`,
      );
    default: {
      const exhaustive: never = message.stopReason;
      throw new Error(`Unhandled stop reason: ${String(exhaustive)}`);
    }
  }
}

function usage(value: Usage): ChatCompletionUsage {
  return {
    prompt_tokens: value.input,
    completion_tokens: value.output,
    total_tokens: value.totalTokens,
  };
}

function wireToolCall(call: ToolCall): WireToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  };
}

export function serializeChatCompletion(
  message: AssistantMessage,
  metadata: ChatCompletionMetadata,
): ChatCompletion {
  const text = message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
  const toolCalls = message.content
    .filter((content) => content.type === "toolCall")
    .map(wireToolCall);
  return {
    ...metadata,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason(message),
      },
    ],
    usage: usage(message.usage),
  };
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export class ChatCompletionSseEncoder {
  readonly #metadata: ChatCompletionMetadata;
  readonly #includeUsage: boolean;
  readonly #toolIndexes = new Map<number, number>();
  #nextToolIndex = 0;
  #started = false;

  constructor(
    metadata: ChatCompletionMetadata,
    options?: { readonly includeUsage?: boolean },
  ) {
    this.#metadata = metadata;
    this.#includeUsage = options?.includeUsage ?? false;
  }

  encode(event: AssistantMessageEvent): readonly string[] {
    switch (event.type) {
      case "start":
        return this.#start();
      case "text_start":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
        return [];
      case "text_delta":
        return [...this.#start(), this.#chunk({ content: event.delta }, null)];
      case "toolcall_start": {
        const call = event.partial.content[event.contentIndex];
        if (!call || call.type !== "toolCall") return [];
        const index = this.#toolIndex(event.contentIndex);
        return [
          ...this.#start(),
          this.#chunk(
            {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: "" },
                },
              ],
            },
            null,
          ),
        ];
      }
      case "toolcall_delta":
        return [
          ...this.#start(),
          this.#chunk(
            {
              tool_calls: [
                {
                  index: this.#toolIndex(event.contentIndex),
                  function: { arguments: event.delta },
                },
              ],
            },
            null,
          ),
        ];
      case "toolcall_end": {
        if (this.#toolIndexes.has(event.contentIndex)) return [];
        const index = this.#toolIndex(event.contentIndex);
        return [
          ...this.#start(),
          this.#chunk(
            {
              tool_calls: [
                {
                  index,
                  id: event.toolCall.id,
                  type: "function",
                  function: {
                    name: event.toolCall.name,
                    arguments: JSON.stringify(event.toolCall.arguments),
                  },
                },
              ],
            },
            null,
          ),
        ];
      }
      case "done": {
        if (event.reason === "deferred") {
          return this.#error("Deferred responses are not supported");
        }
        const output = [
          ...this.#start(),
          this.#chunk({}, finishReason(event.message)),
        ];
        if (this.#includeUsage) {
          output.push(
            sse({
              ...this.#metadata,
              object: "chat.completion.chunk",
              choices: [],
              usage: usage(event.message.usage),
            } satisfies ChatCompletionChunk),
          );
        }
        output.push("data: [DONE]\n\n");
        return output;
      }
      case "error":
        return this.#error(
          event.error.errorMessage ?? `Provider ${event.reason}`,
        );
      default: {
        const exhaustive: never = event;
        throw new Error(`Unhandled event: ${String(exhaustive)}`);
      }
    }
  }

  #start(): string[] {
    if (this.#started) return [];
    this.#started = true;
    return [this.#chunk({ role: "assistant" }, null)];
  }

  #chunk(
    delta: ChatCompletionChunk["choices"][number]["delta"],
    reason: ChatFinishReason | null,
  ): string {
    return sse({
      ...this.#metadata,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: reason }],
      usage: null,
    } satisfies ChatCompletionChunk);
  }

  #toolIndex(contentIndex: number): number {
    const existing = this.#toolIndexes.get(contentIndex);
    if (existing !== undefined) return existing;
    const index = this.#nextToolIndex;
    this.#nextToolIndex += 1;
    this.#toolIndexes.set(contentIndex, index);
    return index;
  }

  #error(message: string): string[] {
    return [sse(serverErrorEnvelope(message)), "data: [DONE]\n\n"];
  }
}

export async function* serializeChatCompletionStream(
  events: AsyncIterable<AssistantMessageEvent>,
  metadata: ChatCompletionMetadata,
  options?: { readonly includeUsage?: boolean },
): AsyncGenerator<string> {
  const encoder = new ChatCompletionSseEncoder(metadata, options);
  for await (const event of events) {
    for (const chunk of encoder.encode(event)) yield chunk;
  }
}
