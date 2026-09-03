/**
 * Request shaping for xAI's Responses endpoint behind the cli-chat-proxy.
 *
 * Pi builds a stock OpenAI Responses payload; xAI rejects parts of it. The
 * fixes follow stnly/pi-grok's sanitizer (MIT), applied here through Pi's
 * `onPayload` hook on the run's agent (the same seam the ChatGPT fast-mode
 * patch uses) rather than a host extension, so the runner keeps
 * `noExtensions: true`:
 *
 *  - replayed `reasoning` items in `input` fail with 400;
 *  - `developer` and `system` roles are rejected in `input` and must become
 *    top-level `instructions`;
 *  - empty-string content items fail validation;
 *  - `function_call_output.output` may not carry image arrays;
 *  - `reasoning.summary` is unsupported, and `reasoning.effort` only exists
 *    on a subset of models;
 *  - `seed`, `parallel_tool_calls`, `service_tier` and
 *    `prompt_cache_retention` come back as 422;
 *  - a tool schema enum containing a `/` is rejected;
 *  - `temperature` is clamped to [0, 2] and `top_p` to [0, 1].
 *
 * Reasoning models get `include: ["reasoning.encrypted_content"]` so the
 * proxy returns replayable encrypted reasoning, and `prompt_cache_key` is
 * pinned to the session for the proxy's conversation cache.
 */

export interface XaiPayloadOptions {
  modelId: string;
  sessionId?: string;
  reasoning: boolean;
  /** The model accepts `reasoning.effort`; otherwise the block is dropped. */
  effortCapable: boolean;
}

type Payload = Record<string, unknown>;

function isRecord(value: unknown): value is Payload {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      return ["text", "input_text", "output_text"].includes(
        String(part.type),
      ) && typeof part.text === "string"
        ? part.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isInputImagePart(value: unknown): value is Payload {
  return isRecord(value) && value.type === "input_image";
}

/** xAI rejects image arrays inside `function_call_output.output`. Keep the
 * text there and hand the images over as a following user message. */
function rewriteFunctionCallOutput(input: Payload[]): Payload[] {
  const rewritten: Payload[] = [];
  for (const item of input) {
    if (item.type !== "function_call_output" || !Array.isArray(item.output)) {
      rewritten.push(item);
      continue;
    }
    const parts: unknown[] = item.output;
    const images = parts.filter(isInputImagePart);
    const text = parts
      .filter((part) => !isInputImagePart(part))
      .map((part) =>
        typeof part === "string"
          ? part
          : isRecord(part) && typeof part.text === "string"
            ? part.text
            : "",
      )
      .filter(Boolean)
      .join("\n");
    rewritten.push({
      ...item,
      output: text || "(tool returned no text output)",
    });
    if (images.length > 0) {
      const callId = item.call_id ? ` (${String(item.call_id)})` : "";
      const plural = images.length === 1 ? "" : "s";
      rewritten.push({
        role: "user",
        content: [
          {
            type: "input_text",
            text: `The previous tool result${callId} included ${images.length} image${plural}. Use the attached image${plural} as the visual output from that tool.`,
          },
          ...images,
        ],
      });
    }
  }
  return rewritten;
}

/** Drop `enum` arrays that contain a slash-bearing string anywhere in a tool
 * schema (xAI answers 422); the tool still registers without the constraint. */
function stripSlashEnums(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripSlashEnums(item);
    return;
  }
  if (!isRecord(node)) return;
  if (
    Array.isArray(node.enum) &&
    node.enum.some((v: unknown) => typeof v === "string" && v.includes("/"))
  ) {
    delete node.enum;
  }
  for (const value of Object.values(node)) stripSlashEnums(value);
}

/** Pure: returns a new payload; the caller's object and its nested tool
 * schemas are never mutated. */
export function sanitizeXaiPayload(
  params: Payload,
  options: XaiPayloadOptions,
): Payload {
  const next: Payload = { ...params };

  if (Array.isArray(next.input)) {
    let input: Payload[] = next.input.flatMap((item: unknown) => {
      if (!isRecord(item)) return [];
      if (item.type === "reasoning") return [];
      if (typeof item.content === "string" && item.content.length === 0)
        return [];
      return [item];
    });
    // Leading system/developer messages become top-level instructions.
    const instructionParts: string[] = [];
    while (input.length > 0) {
      const role = input[0].role;
      if (role !== "developer" && role !== "system") break;
      const text = textFromContent(input[0].content).trim();
      if (text) instructionParts.push(text);
      input = input.slice(1);
    }
    if (instructionParts.length > 0) {
      const existing =
        typeof next.instructions === "string" ? next.instructions : "";
      next.instructions = [existing, ...instructionParts]
        .filter((part) => part.length > 0)
        .join("\n\n");
    }
    next.input = rewriteFunctionCallOutput(input);
  }

  if (next.response_format && !next.text) {
    next.text = { format: next.response_format };
    delete next.response_format;
  }

  if (options.effortCapable) {
    if (isRecord(next.reasoning) && next.reasoning.summary !== undefined) {
      const { summary: _summary, ...rest } = next.reasoning;
      next.reasoning = rest;
    }
  } else {
    delete next.reasoning;
  }

  if (options.reasoning) {
    const want = "reasoning.encrypted_content";
    const include = next.include;
    if (!Array.isArray(include)) next.include = [want];
    else if (!include.includes(want)) next.include = [...include, want];
  }

  delete next.prompt_cache_retention;
  delete next.seed;
  delete next.parallel_tool_calls;
  delete next.service_tier;

  if (Array.isArray(next.tools)) {
    const tools: unknown[] = structuredClone(next.tools);
    stripSlashEnums(tools);
    if (tools.length > 0) next.tools = tools;
    else delete next.tools;
  }

  if (typeof next.temperature === "number") {
    next.temperature = Math.max(0, Math.min(2, next.temperature));
  }
  if (typeof next.top_p === "number") {
    next.top_p = Math.max(0, Math.min(1, next.top_p));
  }

  if (options.sessionId && !next.prompt_cache_key) {
    next.prompt_cache_key = options.sessionId;
  }

  return next;
}

/** Chain the sanitizer onto the agent's payload hook for a SuperGrok run. */
export function enableXaiProxyPayload<TModel>(
  agent: {
    onPayload?: (payload: unknown, model: TModel) => unknown | Promise<unknown>;
  },
  options: XaiPayloadOptions,
): void {
  const baseOnPayload = agent.onPayload;
  agent.onPayload = async (payload, model) => {
    const transformed = await baseOnPayload?.(payload, model);
    const finalPayload = transformed ?? payload;
    if (!isRecord(finalPayload)) return finalPayload;
    return sanitizeXaiPayload(finalPayload, options);
  };
}
