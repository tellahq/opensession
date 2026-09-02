import { describe, expect, test } from "bun:test";
import { enableXaiProxyPayload, sanitizeXaiPayload } from "./xai-payload";

const base = {
  modelId: "grok-4.6",
  sessionId: "session-1",
  reasoning: true,
  effortCapable: true,
};

describe("sanitizeXaiPayload", () => {
  test("moves leading system/developer turns into instructions and drops replayed reasoning", () => {
    const payload = {
      input: [
        { role: "developer", content: "Be terse." },
        {
          role: "system",
          content: [{ type: "input_text", text: "Also kind." }],
        },
        { type: "reasoning", id: "rs_1", encrypted_content: "x" },
        { role: "user", content: "" },
        { role: "user", content: "hello" },
      ],
      store: false,
    };
    const next = sanitizeXaiPayload(payload, base);
    expect(next.instructions).toBe("Be terse.\n\nAlso kind.");
    expect(next.input).toEqual([{ role: "user", content: "hello" }]);
    // The caller's payload is untouched.
    expect(payload.input).toHaveLength(5);
  });

  test("hands tool-result images over as a following user message", () => {
    const next = sanitizeXaiPayload(
      {
        input: [
          {
            type: "function_call_output",
            call_id: "call_1",
            output: [
              { type: "input_text", text: "shot taken" },
              { type: "input_image", image_url: "data:image/png;base64,AA==" },
            ],
          },
        ],
      },
      base,
    );
    const input = next.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({
      type: "function_call_output",
      output: "shot taken",
    });
    expect(input[1]).toMatchObject({ role: "user" });
    expect((input[1].content as unknown[])[1]).toMatchObject({
      type: "input_image",
    });
  });

  test("strips fields the proxy rejects and shapes reasoning per model", () => {
    const capable = sanitizeXaiPayload(
      {
        reasoning: { effort: "high", summary: "auto" },
        seed: 1,
        parallel_tool_calls: true,
        service_tier: "priority",
        prompt_cache_retention: "24h",
        temperature: 5,
        top_p: 2,
        response_format: { type: "json_object" },
      },
      base,
    );
    expect(capable.reasoning).toEqual({ effort: "high" });
    expect(capable.include).toEqual(["reasoning.encrypted_content"]);
    expect(capable).not.toHaveProperty("seed");
    expect(capable).not.toHaveProperty("parallel_tool_calls");
    expect(capable).not.toHaveProperty("service_tier");
    expect(capable).not.toHaveProperty("prompt_cache_retention");
    expect(capable).not.toHaveProperty("response_format");
    expect(capable.text).toEqual({ format: { type: "json_object" } });
    expect(capable.temperature).toBe(2);
    expect(capable.top_p).toBe(1);
    expect(capable.prompt_cache_key).toBe("session-1");

    const plain = sanitizeXaiPayload(
      { reasoning: { effort: "high" }, include: ["other"] },
      { ...base, modelId: "grok-build", effortCapable: false },
    );
    expect(plain).not.toHaveProperty("reasoning");
    expect(plain.include).toEqual(["other", "reasoning.encrypted_content"]);

    const nonReasoning = sanitizeXaiPayload(
      {},
      { ...base, reasoning: false, effortCapable: false },
    );
    expect(nonReasoning).not.toHaveProperty("include");
  });

  test("drops slash enums from tool schemas without mutating the originals", () => {
    const tools = [
      {
        type: "function",
        name: "pick",
        parameters: {
          type: "object",
          properties: { path: { type: "string", enum: ["a/b", "c"] } },
        },
      },
    ];
    const next = sanitizeXaiPayload({ tools }, base);
    const shaped = next.tools as Array<Record<string, any>>;
    expect(shaped[0].parameters.properties.path).not.toHaveProperty("enum");
    expect(tools[0].parameters.properties.path.enum).toEqual(["a/b", "c"]);
    expect(sanitizeXaiPayload({ tools: [] }, base)).not.toHaveProperty("tools");
  });
});

describe("enableXaiProxyPayload", () => {
  test("chains after an existing payload hook", async () => {
    const agent: {
      onPayload?: (payload: unknown, model: string) => unknown;
    } = {
      onPayload: (payload) => ({ ...(payload as object), seed: 7 }),
    };
    enableXaiProxyPayload(agent, base);
    const result = (await agent.onPayload!(
      { input: [{ role: "system", content: "sys" }] },
      "grok-4.6",
    )) as Record<string, unknown>;
    expect(result).not.toHaveProperty("seed");
    expect(result.instructions).toBe("sys");
  });
});
