import { describe, expect, test } from "bun:test";
import { speechResultsText, startBrowserDictation } from "./browser-dictation";

function results(...transcripts: string[]) {
  return transcripts.map((transcript, index) => ({
    0: { transcript },
    isFinal: index < transcripts.length - 1,
    length: 1,
  }));
}

describe("speechResultsText", () => {
  test("joins final and interim browser results", () => {
    expect(
      speechResultsText(results("Open the pull request.", "Then review it")),
    ).toBe("Open the pull request. Then review it");
  });

  test("normalizes service whitespace without changing words", () => {
    expect(
      speechResultsText(results("  First thought ", " and another  ")),
    ).toBe("First thought and another");
  });

  test("ignores an empty recognition result", () => {
    expect(speechResultsText(results("", "Keep this"))).toBe("Keep this");
  });
});

describe("Electron dictation", () => {
  test("streams copied PCM to the native bridge and returns its final text", async () => {
    const originalWindow = globalThis.window;
    const originalNavigator = globalThis.navigator;
    const originalCrypto = globalThis.crypto;
    let processor:
      | {
          onaudioprocess:
            | ((event: {
                inputBuffer: {
                  getChannelData(channel: number): Float32Array;
                };
              }) => void)
            | null;
          connect(): void;
          disconnect(): void;
        }
      | undefined;
    const pushed: Float32Array[] = [];
    let transcript = "";
    const api = {
      start: async (_id: string, sampleRate: number) => ({
        ok: sampleRate === 48_000,
      }),
      push: (_id: string, samples: Float32Array) => pushed.push(samples),
      finish: async () => ({ text: "Native result" }),
      cancel: () => {},
      onText: (callback: (payload: { id: string; text: string }) => void) => {
        queueMicrotask(() =>
          callback({ id: "native-id", text: "Live result" }),
        );
        return () => {};
      },
    };
    class FakeAudioContext {
      sampleRate = 48_000;
      destination = {};
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createScriptProcessor() {
        processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        return processor;
      }
      createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
      }
      close() {
        return Promise.resolve();
      }
    }

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        os1: { dictation: api },
        setTimeout,
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { languages: ["en-US"], language: "en-US" },
    });
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => "native-id" },
    });

    try {
      const dictation = startBrowserDictation((text) => {
        transcript = text;
      }, {} as MediaStream);
      expect(dictation).not.toBeNull();
      const processAudio = processor?.onaudioprocess;
      if (!processAudio) throw new Error("Audio processor was not connected");
      processAudio({
        inputBuffer: { getChannelData: () => new Float32Array([0.25, -0.5]) },
      });
      await Promise.resolve();
      expect(transcript).toBe("Live result");
      expect([...pushed[0]]).toEqual([0.25, -0.5]);
      expect(await dictation!.finish()).toBe("Native result");
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
      });
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});
