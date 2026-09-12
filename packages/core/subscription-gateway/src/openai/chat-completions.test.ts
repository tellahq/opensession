import { describe, expect, test } from "bun:test";
import { decodeChatCompletionRequest } from "./chat-completions";
import { OpenAIRequestError } from "./errors";

function request(overrides: Record<string, unknown> = {}): unknown {
  return {
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

describe("decodeChatCompletionRequest", () => {
  test("maps OpenAI messages and tools into a pi context", () => {
    const decoded = decodeChatCompletionRequest(
      request({
        messages: [
          { role: "system", content: "System rules" },
          { role: "developer", content: [{ type: "text", text: "Be terse" }] },
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,aGVsbG8=" },
              },
            ],
          },
          {
            role: "assistant",
            content: null,
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
          { role: "tool", tool_call_id: "call_1", content: "Rain" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "weather",
              description: "Get weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        tool_choice: "none",
        max_completion_tokens: 512,
        stream: true,
        stream_options: { include_usage: true },
        user: "principal-a",
      }),
      123,
    );

    expect(decoded).toMatchObject({
      model: "claude-sonnet-5",
      stream: true,
      includeUsage: true,
      maxTokens: 512,
      toolChoice: "none",
      endUserId: "principal-a",
      context: {
        systemPrompt: "System rules\n\nBe terse",
        tools: [
          {
            name: "weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
    });
    expect(decoded.context.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ],
        timestamp: 123,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "weather",
            arguments: { city: "Amsterdam" },
          },
        ],
        api: "openai-completions",
        provider: "subscription-gateway",
        model: "claude-sonnet-5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 123,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "weather",
        content: [{ type: "text", text: "Rain" }],
        isError: false,
        timestamp: 123,
      },
    ]);
  });

  test("rejects remote image URLs", () => {
    expect(() =>
      decodeChatCompletionRequest(
        request({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "https://example.com/image.png" },
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow("Only base64 data URLs are supported");
  });

  test("rejects tool results without an earlier matching call", () => {
    expect(() =>
      decodeChatCompletionRequest(
        request({
          messages: [
            { role: "tool", tool_call_id: "missing", content: "result" },
          ],
        }),
      ),
    ).toThrow("No earlier assistant tool call matches missing");
  });

  test("rejects unsupported values instead of ignoring them", () => {
    for (const [field, value] of [
      ["n", 2],
      ["temperature", 0.5],
      ["stop", "END"],
    ] as const) {
      try {
        decodeChatCompletionRequest(request({ [field]: value }));
        throw new Error(`Expected ${field} to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(OpenAIRequestError);
        if (error instanceof OpenAIRequestError)
          expect(error.param).toBe(field);
      }
    }
    expect(() =>
      decodeChatCompletionRequest(
        request({ response_format: { type: "json" } }),
      ),
    ).toThrow("Unrecognized key");
  });

  test("rejects stream options on a non-streaming request", () => {
    expect(() =>
      decodeChatCompletionRequest(
        request({ stream_options: { include_usage: true } }),
      ),
    ).toThrow("stream_options requires stream=true");
  });
});
