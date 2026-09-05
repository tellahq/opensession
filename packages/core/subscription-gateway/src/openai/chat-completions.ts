import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { OpenAIRequestError } from "./errors";

const textPartSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .strict();
const imagePartSchema = z
  .object({
    type: z.literal("image_url"),
    image_url: z
      .object({
        url: z.string(),
        detail: z.enum(["auto", "low", "high"]).optional(),
      })
      .strict(),
  })
  .strict();
const textContentSchema = z.union([z.string(), z.array(textPartSchema).min(1)]);
const userContentSchema = z.union([
  z.string(),
  z
    .array(z.discriminatedUnion("type", [textPartSchema, imagePartSchema]))
    .min(1),
]);
const toolArgumentsObjectSchema = z.record(z.string(), z.unknown());
const toolCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z
      .object({ name: z.string().min(1), arguments: z.string() })
      .strict(),
  })
  .strict();
const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: textContentSchema }).strict(),
  z
    .object({ role: z.literal("developer"), content: textContentSchema })
    .strict(),
  z.object({ role: z.literal("user"), content: userContentSchema }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.union([z.string(), z.null()]).optional(),
      tool_calls: z.array(toolCallSchema).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      tool_call_id: z.string().min(1),
      content: textContentSchema,
    })
    .strict(),
]);
const functionToolSchema = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        strict: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
const requestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .strict()
      .optional(),
    tools: z.array(functionToolSchema).optional(),
    tool_choice: z.enum(["auto", "none"]).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    stop: z.union([z.string(), z.array(z.string()).min(1).max(4)]).optional(),
    user: z.string().optional(),
  })
  .strict();

type ParsedRequest = z.infer<typeof requestSchema>;

export interface DecodedChatCompletionRequest {
  readonly model: string;
  readonly context: Context;
  readonly stream: boolean;
  readonly includeUsage: boolean;
  readonly maxTokens?: number;
  readonly toolChoice: "auto" | "none";
  /** Client-provided provider metadata. Never use this value for pool ownership. */
  readonly endUserId?: string;
}

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function textContent(
  content: string | readonly { readonly type: "text"; readonly text: string }[],
): string {
  return typeof content === "string"
    ? content
    : content.map((part) => part.text).join("");
}

function dataUrlImage(url: string, param: string): ImageContent {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match) {
    throw new OpenAIRequestError(
      "Only base64 data URLs are supported for image inputs",
      { param, code: "unsupported_image_url" },
    );
  }
  return { type: "image", mimeType: match[1], data: match[2] };
}

function toolArguments(value: string, param: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new OpenAIRequestError("Tool arguments must be valid JSON", {
      param,
      code: "invalid_tool_arguments",
    });
  }
  const object = toolArgumentsObjectSchema.safeParse(parsed);
  if (!object.success) {
    throw new OpenAIRequestError("Tool arguments must be a JSON object", {
      param,
      code: "invalid_tool_arguments",
    });
  }
  return object.data;
}

function assistantMessage(
  message: Extract<ParsedRequest["messages"][number], { role: "assistant" }>,
  model: string,
  timestamp: number,
  toolNames: Map<string, string>,
  messageIndex: number,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const [toolIndex, call] of (message.tool_calls ?? []).entries()) {
    toolNames.set(call.id, call.function.name);
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.function.name,
      arguments: toolArguments(
        call.function.arguments,
        `messages.${messageIndex}.tool_calls.${toolIndex}.function.arguments`,
      ),
    });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "subscription-gateway",
    model,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function toolResult(
  message: Extract<ParsedRequest["messages"][number], { role: "tool" }>,
  timestamp: number,
  toolNames: ReadonlyMap<string, string>,
  messageIndex: number,
): ToolResultMessage {
  const toolName = toolNames.get(message.tool_call_id);
  if (!toolName) {
    throw new OpenAIRequestError(
      `No earlier assistant tool call matches ${message.tool_call_id}`,
      {
        param: `messages.${messageIndex}.tool_call_id`,
        code: "unknown_tool_call",
      },
    );
  }
  return {
    role: "toolResult",
    toolCallId: message.tool_call_id,
    toolName,
    content: [{ type: "text", text: textContent(message.content) }],
    isError: false,
    timestamp,
  };
}

function toolsFromRequest(request: ParsedRequest): Tool[] | undefined {
  if (!request.tools?.length) return undefined;
  return request.tools.map((tool, index) => {
    if (tool.function.strict) {
      throw new OpenAIRequestError(
        "Strict function schemas are not supported",
        {
          param: `tools.${index}.function.strict`,
          code: "unsupported_parameter",
        },
      );
    }
    return {
      name: tool.function.name,
      description: tool.function.description ?? "",
      parameters: tool.function.parameters ?? {
        type: "object",
        properties: {},
      },
    };
  });
}

function parseRequest(input: unknown): ParsedRequest {
  const parsed = requestSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const param = issue?.path.join(".") || null;
  throw new OpenAIRequestError(issue?.message ?? "Invalid request", {
    ...(param ? { param } : {}),
  });
}

export function decodeChatCompletionRequest(
  input: unknown,
  timestamp = Date.now(),
): DecodedChatCompletionRequest {
  const request = parseRequest(input);
  if (request.n !== undefined && request.n !== 1) {
    throw new OpenAIRequestError("Only n=1 is supported", {
      param: "n",
      code: "unsupported_parameter",
    });
  }
  if (request.temperature !== undefined) {
    throw new OpenAIRequestError("temperature is not supported", {
      param: "temperature",
      code: "unsupported_parameter",
    });
  }
  if (request.stop !== undefined) {
    throw new OpenAIRequestError("stop is not supported", {
      param: "stop",
      code: "unsupported_parameter",
    });
  }
  if (
    request.max_tokens !== undefined &&
    request.max_completion_tokens !== undefined
  ) {
    throw new OpenAIRequestError(
      "Use max_tokens or max_completion_tokens, not both",
      { param: "max_tokens", code: "conflicting_parameters" },
    );
  }
  if (request.stream_options && !request.stream) {
    throw new OpenAIRequestError("stream_options requires stream=true", {
      param: "stream_options",
      code: "invalid_parameter",
    });
  }

  const system: string[] = [];
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  for (const [index, message] of request.messages.entries()) {
    switch (message.role) {
      case "system":
      case "developer":
        system.push(textContent(message.content));
        break;
      case "user": {
        if (typeof message.content === "string") {
          messages.push({ role: "user", content: message.content, timestamp });
          break;
        }
        const content: (TextContent | ImageContent)[] = message.content.map(
          (part, partIndex) =>
            part.type === "text"
              ? { type: "text", text: part.text }
              : dataUrlImage(
                  part.image_url.url,
                  `messages.${index}.content.${partIndex}.image_url.url`,
                ),
        );
        messages.push({ role: "user", content, timestamp });
        break;
      }
      case "assistant":
        messages.push(
          assistantMessage(message, request.model, timestamp, toolNames, index),
        );
        break;
      case "tool":
        messages.push(toolResult(message, timestamp, toolNames, index));
        break;
      default: {
        const exhaustive: never = message;
        throw new Error(`Unhandled message: ${String(exhaustive)}`);
      }
    }
  }

  return {
    model: request.model,
    context: {
      ...(system.length ? { systemPrompt: system.join("\n\n") } : {}),
      messages,
      ...(request.tools?.length ? { tools: toolsFromRequest(request) } : {}),
    },
    stream: request.stream ?? false,
    includeUsage: request.stream_options?.include_usage ?? false,
    ...((request.max_completion_tokens ?? request.max_tokens)
      ? { maxTokens: request.max_completion_tokens ?? request.max_tokens }
      : {}),
    toolChoice: request.tool_choice ?? "auto",
    ...(request.user ? { endUserId: request.user } : {}),
  };
}
