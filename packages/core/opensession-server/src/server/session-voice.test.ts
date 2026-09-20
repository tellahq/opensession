import { afterEach, expect, spyOn, test } from "bun:test";
import { sessionVoiceConfig, createSessionVoiceAnswer } from "./session-voice";
import { handleSessionVoiceRoutes } from "./routes/session-voice";
import * as voice from "./desk-voice";
import * as sessionCache from "./session-cache";
import * as sessions from "./sessions";

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

test("voice answers from thread context and can request help or dispatch user-requested agent work", () => {
  const config = sessionVoiceConfig("Thread context");
  expect(config.model).toBe("gpt-realtime");
  expect(config.tools.map((tool) => tool.name)).toEqual([
    "request_voice_help",
    "end_voice_call",
  ]);
  expect(config.tools[0]!.parameters.properties.target.enum).toEqual([
    "luna",
    "terra",
    "conversation",
    "session_agent",
  ]);
  expect(config.instructions).toContain("Thread context");
  expect(config.tool_choice).toBe("auto");
  expect(config.audio.input.turn_detection.create_response).toBe(true);
  expect(config.audio.input.turn_detection.interrupt_response).toBe(true);
});

test("session voice ends the user's turn eagerly so replies start sooner", () => {
  const detection =
    sessionVoiceConfig("Thread context").audio.input.turn_detection;
  expect(detection.type).toBe("semantic_vad");
  expect(detection.eagerness).toBe("high");
  // Desk voice keeps its longer-waiting preset.
  expect(voice.DESK_VOICE_TURN_DETECTION.eagerness).toBe("low");
});

test("voice route rejects machine and claimed identities before spending or session lookup", async () => {
  for (const body of [{}, { user: "Alice", sdp: "offer" }]) {
    const req = new Request("http://localhost/api/sessions/test/voice", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const response = await handleSessionVoiceRoutes({
      req,
      url: new URL(req.url),
      path: new URL(req.url).pathname,
      publicPrefix: "",
    });
    expect(response?.status).toBe(401);
  }
});

test("voice route bounds and validates offers", async () => {
  for (const sdp of [
    null,
    "",
    " \r\n\t",
    "x".repeat(65537),
    `${" ".repeat(65536)}x`,
  ]) {
    const req = new Request("http://localhost/api/sessions/test/voice", {
      method: "POST",
      body: JSON.stringify({ sdp }),
    });
    const response = await handleSessionVoiceRoutes({
      req,
      url: new URL(req.url),
      path: new URL(req.url).pathname,
      publicPrefix: "",
      authUser: { login: "alice", name: "Alice" },
    });
    expect(response?.status).toBe(400);
  }
});

test("SDP exchange uses the server key and direct-task policy, returns only the answer", async () => {
  const key = spyOn(voice, "requireVoiceApiKey").mockResolvedValue(
    "private-test-key",
  );
  restores.push(() => key.mockRestore());
  let request: RequestInit | undefined;
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(url)).toBe("https://api.openai.com/v1/realtime/calls");
        request = init;
        return new Response("answer");
      },
      { preconnect() {} },
    ),
  );
  restores.push(() => fetcher.mockRestore());
  expect(
    await createSessionVoiceAnswer(
      "offer",
      new AbortController().signal,
      "Thread context",
    ),
  ).toBe("answer");
  expect(request?.headers).toEqual({
    Authorization: "Bearer private-test-key",
  });
  const form = request?.body as FormData;
  expect(form.get("sdp")).toBe("offer");
  expect(JSON.parse(String(form.get("session")))).toEqual(
    sessionVoiceConfig("Thread context"),
  );
});

test("provider failures do not leak response bodies or credentials", async () => {
  const key = spyOn(voice, "requireVoiceApiKey").mockResolvedValue(
    "private-test-key",
  );
  restores.push(() => key.mockRestore());
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => new Response("private provider diagnostic", { status: 403 }),
      { preconnect() {} },
    ),
  );
  restores.push(() => fetcher.mockRestore());
  await expect(
    createSessionVoiceAnswer(
      "offer",
      new AbortController().signal,
      "Thread context",
    ),
  ).rejects.toThrow("OpenAI could not start the voice call (HTTP 403).");
});

test("voice route preserves the browser SDP byte-for-byte through provider exchange", async () => {
  const session = spyOn(sessionCache, "findSessionAsync").mockResolvedValue({
    id: "voice-test",
    source: "opensession",
    claudeSessionId: null,
    branch: null,
    worktreeDir: null,
    startedBy: "alice",
    title: "Voice test",
    lastActivity: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    isRunning: false,
    transcriptPath: null,
  });
  const transcript = spyOn(
    sessions,
    "mergedSessionTranscriptAsync",
  ).mockResolvedValue([]);
  const key = spyOn(voice, "requireVoiceApiKey").mockResolvedValue(
    "synthetic-key",
  );
  restores.push(
    () => session.mockRestore(),
    () => transcript.mockRestore(),
    () => key.mockRestore(),
  );
  // Synthetic SDP with significant CRLF framing, not an actual browser offer.
  const sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const form = init?.body as FormData;
        expect(form.get("sdp")).toBe(sdp);
        return new Response("answer");
      },
      { preconnect() {} },
    ),
  );
  restores.push(() => fetcher.mockRestore());
  const req = new Request("http://example.test/api/sessions/voice-test/voice", {
    method: "POST",
    body: JSON.stringify({ sdp }),
  });
  const response = await handleSessionVoiceRoutes({
    req,
    url: new URL(req.url),
    path: new URL(req.url).pathname,
    publicPrefix: "",
    authUser: { login: "alice", name: "Alice" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ sdp: "answer" });
});

for (const [code, detail] of [
  [
    "invalid_offer",
    " OpenAI rejected the browser's audio connection offer (invalid_offer).",
  ],
  [
    "insufficient_quota",
    " The voice API account has insufficient quota. Check its billing and limits.",
  ],
  ["private-test-key", ""],
]) {
  test(`provider diagnostic ${code} only selects safe, fixed copy`, async () => {
    const key = spyOn(voice, "requireVoiceApiKey").mockResolvedValue(
      "private-test-key",
    );
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () =>
          Response.json(
            {
              error: {
                code,
                message: "private-test-key and transcript content",
                param: "private-test-key",
              },
            },
            { status: 400 },
          ),
        { preconnect() {} },
      ),
    );
    restores.push(
      () => key.mockRestore(),
      () => fetcher.mockRestore(),
    );
    await expect(
      createSessionVoiceAnswer(
        "offer",
        new AbortController().signal,
        "Thread context",
      ),
    ).rejects.toThrow(
      `OpenAI could not start the voice call (HTTP 400).${detail}`,
    );
  });
}

test("the voice tool describes prompt as the direct task, not a request to propose work", () => {
  const description =
    sessionVoiceConfig("").tools[0]!.parameters.properties.prompt.description;
  expect(description).toContain("task message delivered verbatim");
  expect(description).toContain("Do not add a delegation preamble");
  expect(description).toContain("when the user requests work");
  expect(sessionVoiceConfig("").tools[0]!.description).toContain(
    "Explicit user requests need no additional approval",
  );
});

test("voice has a narrow call-ending tool that cannot cancel agent work", () => {
  const tool = sessionVoiceConfig("").tools[1];
  expect(tool.name).toBe("end_voice_call");
  expect(tool.parameters.properties).toEqual({});
  expect(tool.parameters.additionalProperties).toBe(false);
  expect(tool.description).toContain("without cancelling agent work");
});
