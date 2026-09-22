import { afterEach, expect, spyOn, test } from "bun:test";
import {
  askSessionConversationModel,
  askSessionVoiceHelper,
  askSessionVoiceTarget,
  sessionConversationModel,
} from "./session-voice-helper";
import { handleSessionVoiceRoutes } from "./routes/session-voice";
import * as voice from "./desk-voice";
import * as oneShot from "./one-shot";
import { interactiveDefaultModel } from "./models";

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        handler(String(url), init),
      { preconnect() {} },
    ),
  );
  restores.push(() => fetcher.mockRestore());
}

function mockKey() {
  const key = spyOn(voice, "requireVoiceApiKey").mockResolvedValue(
    "synthetic-key",
  );
  restores.push(() => key.mockRestore());
}

const session = {
  id: "session",
  model: "claude-opus-5-5",
  effort: "high",
  startedBy: "alice",
};

for (const model of ["luna", "terra"] as const) {
  test(`${model} uses a short stateless Responses call with no agent tools`, async () => {
    mockKey();
    let body: Record<string, unknown> | undefined;
    mockFetch(async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(init?.headers).toEqual({
        Authorization: "Bearer synthetic-key",
        "Content-Type": "application/json",
      });
      body = JSON.parse(String(init?.body));
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "The retry limit prevents duplicate work.",
              },
            ],
          },
        ],
      });
    });
    expect(
      await askSessionVoiceHelper(
        model,
        "Explain the retry change",
        "Thread excerpt",
        new AbortController().signal,
      ),
    ).toBe("The retry limit prevents duplicate work.");
    expect(body?.model).toBe(`gpt-5.6-${model}`);
    expect(body?.reasoning).toEqual({ effort: "low" });
    expect(body?.tools).toEqual([]);
    expect(body?.store).toBe(false);
    expect(body?.max_output_tokens).toBe(1600);
    expect(body?.input).toContain("Thread excerpt");
  });
}

test("helper rejects incomplete provider replies rather than claiming a completed answer", async () => {
  mockKey();
  mockFetch(async () => Response.json({ status: "incomplete", output: [] }));
  await expect(
    askSessionVoiceHelper(
      "luna",
      "Question",
      "Thread",
      new AbortController().signal,
    ),
  ).rejects.toThrow("did not finish");
});

test("conversation target resolves the session's stored model and effort like dispatch", () => {
  expect(sessionConversationModel(session)).toEqual({
    model: "pi/anthropic/claude-opus-5-5",
    effort: "high",
  });
  expect(
    sessionConversationModel({ model: "pi/openai/gpt-5.6-sol", effort: "" }),
  ).toEqual({ model: "pi/openai/gpt-5.6-sol" });
  // Unknown effort strings never reach the one-shot options.
  expect(
    sessionConversationModel({ model: "claude-opus-5-5", effort: "turbo" }),
  ).toEqual({ model: "pi/anthropic/claude-opus-5-5" });
});

test("conversation target uses a preset's pinned effort and lead model", () => {
  expect(sessionConversationModel({ model: "dial/ultra" })).toEqual({
    model: "pi/anthropic/claude-fable-5-1",
    effort: "high",
  });
});

test("conversation target falls back to the instance interactive default, never a client model", () => {
  const expected = sessionConversationModel({
    model: interactiveDefaultModel(),
  });
  expect(sessionConversationModel({})).toEqual(expected);
  expect(sessionConversationModel({ model: "   " })).toEqual(expected);
});

test("conversation target runs one tool-less one-shot on the session model without a transcript", async () => {
  let prompt = "";
  let opts: oneShot.OneShotOpts | undefined;
  const run = spyOn(oneShot, "oneShotDetailed").mockImplementation(
    async (p, o) => {
      prompt = p;
      opts = o;
      return {
        text: "The change bounds retries.",
        error: null,
        model: "pi/anthropic/claude-opus-5-5",
      };
    },
  );
  restores.push(() => run.mockRestore());
  expect(
    await askSessionConversationModel(
      session,
      "Why was the retry bounded?",
      "Thread excerpt",
      "bob",
    ),
  ).toEqual({
    text: "The change bounds retries.",
    model: "pi/anthropic/claude-opus-5-5",
  });
  expect(prompt).toContain("Why was the retry bounded?");
  expect(prompt).toContain("Thread excerpt");
  expect(opts?.model).toBe("pi/anthropic/claude-opus-5-5");
  expect(opts?.effort).toBe("high");
  expect(opts?.user).toBe("bob");
  expect(opts?.label).toBe("session-voice-conversation");
  expect(opts?.system).toContain("no repository or external tools");
  expect(opts?.fallbackModels).toBeUndefined();
});

test("conversation target reports failure instead of escalating to the agent", async () => {
  const run = spyOn(oneShot, "oneShotDetailed").mockResolvedValue({
    text: null,
    error: "no usable account",
  });
  restores.push(() => run.mockRestore());
  await expect(
    askSessionVoiceTarget(
      "conversation",
      session,
      "Question",
      "Thread",
      new AbortController().signal,
    ),
  ).rejects.toThrow("Nothing was sent to the session agent");
});

test("helper endpoint requires human authentication and the exact target allowlist", async () => {
  for (const [model, signedIn, status] of [
    ["luna", false, 401],
    ["conversation", false, 401],
    ["other-model", true, 400],
    ["gpt-5.6-sol", true, 400],
    ["session_agent", true, 400],
  ] as const) {
    const req = new Request(
      "http://localhost/api/sessions/session/voice/helper",
      {
        method: "POST",
        body: JSON.stringify({ model, prompt: "Explain the thread" }),
      },
    );
    const response = await handleSessionVoiceRoutes({
      req,
      url: new URL(req.url),
      path: new URL(req.url).pathname,
      publicPrefix: "",
      authUser: signedIn ? { login: "alice", name: "Alice" } : null,
    });
    expect(response?.status).toBe(status);
  }
});
