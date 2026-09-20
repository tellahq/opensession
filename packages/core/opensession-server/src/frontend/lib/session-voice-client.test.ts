import { afterEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import {
  SessionVoiceClient,
  type SessionVoiceState,
} from "./session-voice-client";

const restores: Array<() => void> = [];
function install(name: string, replacement: PropertyDescriptor) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    ...replacement,
  });
  restores.push(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

interface TestMicrophone {
  getTracks(): Array<{ stop(): void; onended: null }>;
}
interface TestEvent {
  type: string;
  item_id?: string;
  transcript?: string;
  name?: string;
  arguments?: string;
  response_id?: string;
  response?: {
    id?: string;
    status?: string;
    metadata?: { voiceApproval: string };
  };
  call_id?: string;
}
const commandSchema = z.object({
  type: z.string(),
  item: z
    .object({
      type: z.string(),
      call_id: z.string().optional(),
      output: z.string().optional(),
      content: z.array(z.object({ text: z.string() })).optional(),
    })
    .optional(),
  session: z.object({ instructions: z.string() }).optional(),
  response: z
    .object({
      instructions: z.string().optional(),
      metadata: z.object({ voiceApproval: z.string() }).optional(),
      tool_choice: z.string().optional(),
    })
    .optional(),
});
class TestChannel {
  readyState = "open";
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<z.infer<typeof commandSchema>> = [];
  send(value: string) {
    this.sent.push(commandSchema.parse(JSON.parse(value)));
  }
  close() {}
}
function setup(options?: {
  mic?: () => Promise<TestMicrophone>;
  denied?: boolean;
  acceptAgent?: boolean;
  helper?: () => Promise<Response>;
}) {
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  let stopped = 0;
  let closed = 0;
  let fetches = 0;
  let requestBody = "";
  const track = {
    enabled: true,
    stop() {
      stopped++;
    },
    onended: null,
  };
  const stream = { getTracks: () => [track] };
  const channel = new TestChannel();
  const sent = channel.sent;
  const states: Array<[SessionVoiceState, string | undefined]> = [];
  const prompts: string[] = [];
  const helpers: Array<{ model: string; prompt: string }> = [];
  install("window", { value: windowEvents });
  const playback = {
    play: async () => {},
    pause() {},
    srcObject: null,
    muted: false,
  };
  install("document", {
    value: Object.assign(documentEvents, { createElement: () => playback }),
  });
  install("navigator", {
    value: {
      mediaDevices: {
        getUserMedia:
          options?.mic ??
          (async () => {
            if (options?.denied)
              throw new DOMException("Denied", "NotAllowedError");
            return stream;
          }),
      },
    },
  });
  install("RTCPeerConnection", {
    value: class {
      localDescription = { sdp: "offer" };
      addTrack() {}
      createDataChannel() {
        return channel;
      }
      async createOffer() {
        return this.localDescription;
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        channel.onopen?.();
      }
      close() {
        closed++;
      }
    },
  });
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(url).endsWith("/voice/helper")) {
          helpers.push(
            z
              .object({ model: z.string(), prompt: z.string() })
              .parse(JSON.parse(String(init?.body))),
          );
          return options?.helper
            ? options.helper()
            : Response.json({ text: "Helper analysis" });
        }
        expect(String(url)).toEndWith("/api/sessions/test-session/voice");
        fetches++;
        requestBody = String(init?.body);
        return Response.json({ sdp: "answer" });
      },
      { preconnect() {} },
    ),
  );
  restores.push(() => fetcher.mockRestore());
  const client = new SessionVoiceClient({
    sessionId: "test-session",
    onState: (state, detail) => states.push([state, detail]),
    context: "Initial thread",
    onAgentRequest: (prompt) => {
      prompts.push(prompt);
      return options?.acceptAgent ?? true;
    },
  });
  restores.push(() => client.stop());
  return {
    client,
    stream,
    playback,
    sent,
    prompts,
    helpers,
    states,
    windowEvents,
    documentEvents,
    emit: (event: TestEvent) =>
      channel.onmessage?.({ data: JSON.stringify(event) }),
    stats: () => ({ stopped, closed, fetches, requestBody }),
  };
}

function propose(
  h: ReturnType<typeof setup>,
  target = "session_agent",
  callId = "request-one",
) {
  h.emit({
    type: "response.function_call_arguments.done",
    call_id: callId,
    name: "request_voice_help",
    arguments: JSON.stringify({
      target,
      prompt: "Explain the retry change",
      reason: "A second opinion would help",
      approved: true,
    }),
  });
  h.emit({ type: "response.done", response: { status: "completed" } });
}
function speak(h: ReturnType<typeof setup>, text: string, id = "spoken-one") {
  h.emit({ type: "input_audio_buffer.speech_started", item_id: id });
  h.emit({ type: "input_audio_buffer.speech_stopped", item_id: id });
  h.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: id,
    transcript: text,
  });
}
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("ordinary voice questions never send thread messages or invoke helpers", async () => {
  const h = setup();
  await h.client.start();
  speak(h, "Why did it change that?");
  h.emit({ type: "response.created" });
  h.emit({ type: "output_audio_buffer.started" });
  h.emit({ type: "response.done", response: { status: "completed" } });
  h.emit({ type: "output_audio_buffer.stopped" });
  expect(h.prompts).toEqual([]);
  expect(h.helpers).toEqual([]);
  expect(h.sent).toEqual([]);
});

test("an explicit task tool call sends immediately and deduplicates repeated call events", async () => {
  const h = setup();
  await h.client.start();
  propose(h);
  propose(h);
  await tick();
  expect(h.prompts).toEqual(["Explain the retry change"]);
  expect(h.sent.some((event) => event.response?.metadata?.voiceApproval)).toBe(
    false,
  );
});

test.each(["luna", "terra", "conversation"])(
  "automatically consults %s without approval or waking the session agent",
  async (model) => {
    const h = setup();
    await h.client.start();
    propose(h, model);
    await tick();
    expect(
      h.sent.some((event) => event.response?.metadata?.voiceApproval),
    ).toBe(false);
    expect(h.helpers).toEqual([{ model, prompt: "Explain the retry change" }]);
    expect(h.prompts).toEqual([]);
    expect(
      h.sent.some((event) =>
        event.item?.content?.[0]?.text.includes("Helper analysis"),
      ),
    ).toBe(true);
  },
);

test("a failed helper does not silently escalate to the coding agent", async () => {
  const h = setup({
    helper: async () => new Response("unavailable", { status: 503 }),
  });
  await h.client.start();
  propose(h, "luna");
  await tick();
  expect(h.prompts).toEqual([]);
  expect(
    h.sent.some((event) =>
      event.item?.content?.[0]?.text.includes("could not complete"),
    ),
  ).toBe(true);
});

test("unknown tools cannot propose or perform work", async () => {
  const h = setup();
  await h.client.start();
  h.emit({
    type: "response.function_call_arguments.done",
    call_id: "bad",
    name: "bash",
    arguments: "{}",
  });
  speak(h, "yes");
  await tick();
  expect(h.prompts).toEqual([]);
  expect(h.helpers).toEqual([]);
});

test("thread updates change context without posting or speaking", async () => {
  const h = setup();
  await h.client.start();
  h.client.updateContext("Initial thread");
  expect(h.sent).toEqual([]);
  h.client.updateContext("New agent reply");
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]?.session?.instructions).toContain("New agent reply");
});

test("requested agent results come back to the voice discussion", async () => {
  const h = setup();
  await h.client.start();
  h.client.agentReply("Unsolicited");
  expect(h.sent).toEqual([]);
  propose(h);
  speak(h, "yes please");
  await tick();
  h.client.agentReply("CI passes now");
  expect(
    h.sent.some((event) =>
      event.item?.content?.[0]?.text.includes("CI passes now"),
    ),
  ).toBe(true);
});

test("barge-in cancels speech only", async () => {
  const h = setup();
  await h.client.start();
  h.emit({ type: "response.created" });
  h.emit({ type: "output_audio_buffer.started" });
  h.emit({ type: "input_audio_buffer.speech_started", item_id: "interrupt" });
  expect(h.sent.map((event) => event.type)).toEqual([
    "response.cancel",
    "output_audio_buffer.clear",
  ]);
  expect(h.prompts).toEqual([]);
});

test("permission denial never starts a paid call", async () => {
  const h = setup({ denied: true });
  await h.client.start();
  expect(h.states.at(-1)).toEqual([
    "error",
    "Microphone permission denied. Allow access and try again.",
  ]);
  expect(h.stats().fetches).toBe(0);
});

test("hanging up while permission is pending releases a late microphone", async () => {
  let resolve!: (value: TestMicrophone) => void;
  const h = setup({
    mic: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const start = h.client.start();
  h.client.stop();
  resolve(h.stream);
  await start;
  expect(h.stats().stopped).toBe(1);
  expect(h.stats().fetches).toBe(0);
  expect(h.states.at(-1)?.[0]).toBe("idle");
});

test.each(["pagehide", "opensession-voice-call-start"])(
  "%s releases mic and prevents late sends",
  async (event) => {
    const h = setup();
    await h.client.start();
    h.windowEvents.dispatchEvent(new Event(event));
    h.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "late",
      transcript: "Don't send",
    });
    expect(h.stats().stopped).toBe(1);
    expect(h.stats().closed).toBe(1);
    expect(h.prompts).toEqual([]);
  },
);

test("hanging up prevents late task calls and results", async () => {
  const h = setup();
  await h.client.start();
  h.client.stop();
  propose(h);
  h.client.agentReply("Late result");
  await tick();
  expect(h.prompts).toEqual([]);
  expect(h.sent).toEqual([]);
});

test("pause mutes both directions without closing the call, and resume restores them", async () => {
  const h = setup();
  await h.client.start();
  h.client.setPaused(true);
  expect(h.states.at(-1)?.[0]).toBe("paused");
  expect(h.stream.getTracks()[0]?.enabled).toBe(false);
  expect(h.playback.muted).toBe(true);
  expect(h.stats().closed).toBe(0);
  expect(h.stats().stopped).toBe(0);
  h.client.setPaused(false);
  expect(h.states.at(-1)?.[0]).toBe("listening");
  expect(h.stream.getTracks()[0]?.enabled).toBe(true);
  expect(h.playback.muted).toBe(false);
  expect(h.stats().fetches).toBe(1);
});

test("pause blocks new task and helper calls, including replay after resume", async () => {
  const h = setup();
  await h.client.start();
  h.client.setPaused(true);
  propose(h);
  propose(h, "luna", "late-helper");
  await tick();
  h.client.setPaused(false);
  propose(h);
  expect(h.prompts).toEqual([]);
  expect(h.helpers).toEqual([]);
});

test("a helper finishing during pause waits to speak until resume", async () => {
  let finish: (response: Response) => void = () => {};
  const h = setup({
    helper: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.client.start();
  propose(h, "luna");
  h.client.setPaused(true);
  h.emit({ type: "response.done", response: { status: "cancelled" } });
  const before = h.sent.filter(
    (event) => event.type === "response.create",
  ).length;
  finish(Response.json({ text: "The helper finished while paused" }));
  await tick();
  expect(h.states.at(-1)?.[0]).toBe("paused");
  expect(
    h.sent.filter((event) => event.type === "response.create"),
  ).toHaveLength(before);
  h.client.setPaused(false);
  expect(
    h.sent.filter((event) => event.type === "response.create"),
  ).toHaveLength(before + 1);
});

test("a direct task is forwarded without its reason or a confirmation wrapper", async () => {
  const h = setup();
  await h.client.start();
  const prompt =
    "Adjust the voice orb.\n- Increase microphone reactivity.\n- Preserve reduced motion.";
  h.emit({
    type: "response.function_call_arguments.done",
    call_id: "request-one",
    name: "request_voice_help",
    arguments: JSON.stringify({
      target: "session_agent",
      prompt,
      reason: "Make speaking activity easier to see",
    }),
  });
  h.emit({ type: "response.done", response: { status: "completed" } });
  await tick();
  expect(h.prompts).toEqual([prompt]);
});

test("multiple tasks remain outstanding through pause and narrate each result once", async () => {
  const h = setup();
  await h.client.start();
  for (let i = 0; i < 3; i++) {
    propose(h, "session_agent", `request-${i}`);
    await tick();
    h.emit({ type: "response.done", response: { status: "completed" } });
  }
  expect(h.prompts).toHaveLength(3);
  h.client.agentReply("First result");
  h.emit({ type: "response.done", response: { status: "completed" } });
  expect(h.states.at(-1)?.[0]).toBe("working");
  h.client.setPaused(true);
  const responses = h.sent.filter(
    (event) => event.type === "response.create",
  ).length;
  h.client.agentReply("Combined result", "Second and third tasks", 2);
  expect(
    h.sent.filter((event) => event.type === "response.create"),
  ).toHaveLength(responses);
  h.client.setPaused(false);
  expect(
    h.sent.filter((event) => event.type === "response.create"),
  ).toHaveLength(responses + 1);
  for (const result of ["First result", "Combined result"])
    expect(
      h.sent.filter((event) => event.item?.content?.[0]?.text.includes(result)),
    ).toHaveLength(1);
  h.client.agentReply("Unsolicited extra");
  h.client.stop();
  h.client.agentReply("Stale result");
  expect(
    h.sent.some((event) =>
      /Unsolicited extra|Stale result/.test(
        event.item?.content?.[0]?.text ?? "",
      ),
    ),
  ).toBe(false);
});

test("the farewell tool releases the call once without cancelling submitted tasks", async () => {
  const h = setup();
  await h.client.start();
  propose(h);
  await tick();
  const end = {
    type: "response.function_call_arguments.done",
    name: "end_voice_call",
    call_id: "end",
    arguments: "{}",
  };
  h.emit(end);
  h.emit(end);
  expect(h.stats().closed).toBe(1);
  expect(h.stats().stopped).toBe(1);
  expect(h.states.at(-1)?.[0]).toBe("idle");
  expect(h.prompts).toHaveLength(1);
  const sent = h.sent.length;
  h.client.agentReply("Finished after hanging up");
  expect(h.sent).toHaveLength(sent);
});

test.each(["not-json", '{"task":"cancel agent work"}'])(
  "malformed farewell arguments keep the call open: %s",
  async (argumentsText) => {
    const h = setup();
    await h.client.start();
    h.emit({
      type: "response.function_call_arguments.done",
      name: "end_voice_call",
      call_id: "end",
      arguments: argumentsText,
    });
    expect(h.stats().closed).toBe(0);
    expect(h.prompts).toEqual([]);
  },
);

test("paused calls ignore farewell tools and raw quoted bye text is not a local hangup trigger", async () => {
  const h = setup();
  await h.client.start();
  speak(h, "What does the word bye mean?");
  expect(h.stats().closed).toBe(0);
  h.client.setPaused(true);
  h.emit({
    type: "response.function_call_arguments.done",
    name: "end_voice_call",
    call_id: "end",
    arguments: "{}",
  });
  expect(h.stats().closed).toBe(0);
  h.client.setPaused(false);
  h.emit({
    type: "response.function_call_arguments.done",
    name: "end_voice_call",
    call_id: "end",
    arguments: "{}",
  });
  expect(h.stats().closed).toBe(0);
});

test("successful task handoffs ask for a short acknowledgement, never a repeated task summary", async () => {
  const h = setup();
  await h.client.start();
  propose(h);
  await tick();
  expect(
    h.sent.some((event) =>
      event.item?.content?.some(
        (content) =>
          content.text.includes('Acknowledge once with at most "On it."') &&
          content.text.includes("Do not restate or summarize"),
      ),
    ),
  ).toBe(true);
});
