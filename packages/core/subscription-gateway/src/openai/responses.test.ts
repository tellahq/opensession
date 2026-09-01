import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import {
  chatCompletionMetadata,
  serializeChatCompletion,
  serializeChatCompletionStream,
} from "./responses";

const usage: Usage = {
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 0,
  totalTokens: 18,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  input: Pick<AssistantMessage, "content" | "stopReason">,
): AssistantMessage {
  return {
    role: "assistant",
    content: input.content,
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage,
    stopReason: input.stopReason,
    timestamp: 123,
  };
}

const metadata = chatCompletionMetadata({
  id: "chatcmpl-test",
  model: "gpt-5.6-sol",
  now: 123_000,
});

describe("serializeChatCompletion", () => {
  test("serializes text, tool calls, finish reason, and usage", () => {
    expect(
      serializeChatCompletion(
        assistant({
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "Checking." },
            {
              type: "toolCall",
              id: "call_1",
              name: "weather",
              arguments: { city: "Amsterdam" },
            },
          ],
          stopReason: "toolUse",
        }),
        metadata,
      ),
    ).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 123,
      model: "gpt-5.6-sol",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Checking.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "weather",
                  arguments: '{"city":"Amsterdam"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    });
  });

  test("does not expose thinking as assistant content", () => {
    const completion = serializeChatCompletion(
      assistant({
        content: [{ type: "thinking", thinking: "private" }],
        stopReason: "stop",
      }),
      metadata,
    );
    expect(completion.choices[0].message.content).toBeNull();
  });
});

describe("serializeChatCompletionStream", () => {
  test("writes OpenAI chunks, streamed tool arguments, usage, and DONE", async () => {
    const partial = assistant({
      content: [
        { type: "text", text: "Checking" },
        {
          type: "toolCall",
          id: "call_1",
          name: "weather",
          arguments: {},
        },
      ],
      stopReason: "pending",
    });
    const completeToolCall: ToolCall = {
      type: "toolCall",
      id: "call_1",
      name: "weather",
      arguments: { city: "Amsterdam" },
    };
    const done = assistant({
      content: [{ type: "text", text: "Checking" }, completeToolCall],
      stopReason: "toolUse",
    });
    async function* events(): AsyncGenerator<AssistantMessageEvent> {
      yield { type: "start", partial };
      yield { type: "text_start", contentIndex: 0, partial };
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "Checking",
        partial,
      };
      yield { type: "text_end", contentIndex: 0, content: "Checking", partial };
      yield { type: "toolcall_start", contentIndex: 1, partial };
      yield {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '{"city":',
        partial,
      };
      yield {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '"Amsterdam"}',
        partial,
      };
      yield {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: completeToolCall,
        partial: done,
      };
      yield { type: "done", reason: "toolUse", message: done };
    }

    const chunks: string[] = [];
    for await (const chunk of serializeChatCompletionStream(
      events(),
      metadata,
      {
        includeUsage: true,
      },
    )) {
      chunks.push(chunk);
    }
    const payloads = chunks.map((chunk) => chunk.trim().replace(/^data: /, ""));
    expect(payloads).toEqual([
      '{"id":"chatcmpl-test","created":123,"model":"gpt-5.6-sol","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}],"usage":null}',
      '{"id":"chatcmpl-test","created":123,"model":"gpt-5.6-sol","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Checking"},"finish_reason":null}],"usage":null}',
      '{"id":"chatcmpl-test","created":123,"model":"gpt-5.6-sol","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":""}}]},"finish_reason":null}],"usage":null}',
      '{"id":"chatcmpl-test","created":123,"model":"gpt-5.6-sol","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"city\\\":"}}]},"finish_reason":null}],"usage":null}',
      '{"id":"chatcmpl-test","created":123,"model":"gpt-5.6-sol","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"Amsterdam\\\"}"}}]},"finish_reason":null}],"usage":null}',
      '{"id":"chatcmpl-test","created":123,"model":"gpt-5.6-sol","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":null}',
      '{"id":"chatcmpl-test","created":123,"model":"gpt-5.6-sol","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
      "[DONE]",
    ]);
  });

  test("emits a complete tool call when the provider skips start and delta", async () => {
    const done = assistant({
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "weather",
          arguments: { city: "Amsterdam" },
        },
      ],
      stopReason: "toolUse",
    });
    async function* events(): AsyncGenerator<AssistantMessageEvent> {
      const toolCall = done.content[0];
      if (toolCall.type !== "toolCall") return;
      yield {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall,
        partial: done,
      };
      yield { type: "done", reason: "toolUse", message: done };
    }
    const chunks: string[] = [];
    for await (const chunk of serializeChatCompletionStream(
      events(),
      metadata,
    )) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toContain(
      '"function":{"name":"weather","arguments":"{\\"city\\":\\"Amsterdam\\"}"}',
    );
  });

  test("turns provider errors into an SSE error envelope and DONE", async () => {
    const failed = assistant({ content: [], stopReason: "error" });
    failed.errorMessage = "Provider unavailable";
    async function* events(): AsyncGenerator<AssistantMessageEvent> {
      yield { type: "error", reason: "error", error: failed };
    }
    const chunks: string[] = [];
    for await (const chunk of serializeChatCompletionStream(
      events(),
      metadata,
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('"message":"Provider unavailable"');
    expect(chunks[1]).toBe("data: [DONE]\n\n");
  });
});
