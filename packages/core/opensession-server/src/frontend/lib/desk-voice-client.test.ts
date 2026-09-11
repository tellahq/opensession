import { afterEach, expect, spyOn, test } from "bun:test";
import { DeskVoiceClient } from "./desk-voice-client";

const originals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, descriptor: PropertyDescriptor) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    ...descriptor,
  });
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

test("teardown posts one keepalive report with counters, never transcript or audio", async () => {
  const windowEvents = new EventTarget();
  install("window", {
    value: Object.assign(windowEvents, { setTimeout, clearTimeout }),
  });
  install("document", { value: new EventTarget() });
  install("navigator", {
    value: {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    },
  });
  class FakeChannel {
    readyState = "open";
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    close() {}
    send() {}
  }
  const channel = new FakeChannel();
  const emit = (event: {
    type: string;
    delta?: string;
    error?: { message: string };
  }) => channel.onmessage?.({ data: JSON.stringify(event) });
  install("RTCPeerConnection", {
    value: class {
      iceGatheringState = "complete";
      localDescription = { sdp: "synthetic offer" };
      addTrack() {}
      createDataChannel() {
        return channel;
      }
      async createOffer() {
        return this.localDescription;
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        setTimeout(() => emit({ type: "session.started" }), 0);
      }
      close() {}
    },
  });
  const reports: Array<{ body: string; keepalive?: boolean }> = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (String(url).endsWith("/diag")) {
          reports.push({
            body: String(init?.body),
            keepalive: init?.keepalive,
          });
        }
        return Response.json(
          String(url).endsWith("/live")
            ? {
                liveSessionId: "live-test",
                sdp: "synthetic answer",
                sessionId: "desk-test",
                backendModel: "gpt-5.6-luna",
              }
            : { ok: true },
        );
      },
      { preconnect() {} },
    ),
  );
  const client = new DeskVoiceClient({ user: "Test", onState() {} });
  try {
    await client.start();
    emit({ type: "session.input_transcript.delta", delta: "private words" });
    emit({ type: "session.output_transcript.delta", delta: "private reply" });
    emit({
      type: "session.output_transcript.delta",
      delta: "more private words",
    });
    emit({ type: "session.delegation.created" });
    emit({ type: "error", error: { message: "test error" } });
    // Page close must report immediately, without relying on the close grace timer.
    windowEvents.dispatchEvent(new Event("pagehide"));
    client.stop();
    windowEvents.dispatchEvent(new Event("pagehide"));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.keepalive).toBe(true);
    expect(JSON.parse(reports[0]?.body ?? "null")).toEqual({
      user: "Test",
      engine: "live",
      origin: "client",
      liveSessionId: "live-test",
      backendModel: "gpt-5.6-luna",
      micGranted: true,
      sawStarted: true,
      closeReason: "hidden",
      sessionCloseReason: null,
      durationSeconds: 0,
      inputDeltas: 1,
      outputDeltas: 2,
      delegations: 1,
      lastError: "test error",
    });
    expect(JSON.stringify(reports)).not.toContain("private");
  } finally {
    client.stop();
    fetchMock.mockRestore();
  }
});

test("denied microphone reports a failed start once", async () => {
  install("window", {
    value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }),
  });
  install("document", { value: new EventTarget() });
  install("navigator", {
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          throw new Error("denied");
        },
      },
    },
  });
  const reports: unknown[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        _url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        reports.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      },
      { preconnect() {} },
    ),
  );
  const client = new DeskVoiceClient({ user: "Test", onState() {} });
  try {
    await expect(client.start()).rejects.toThrow(
      "Microphone permission denied",
    );
    client.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      micGranted: false,
      sawStarted: false,
      closeReason: "microphone denied",
      inputDeltas: 0,
      outputDeltas: 0,
    });
  } finally {
    fetchMock.mockRestore();
  }
});
