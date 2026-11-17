import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceAudioSection } from "./VoiceAudioSection";

// `os1Shell()` reads `globalThis.window?.os1`. One process runs every test
// file, so add to an existing window rather than replacing it, and take only
// our own key back out.
const testWindow = globalThis.window ?? {};
if (!globalThis.window) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
    writable: true,
  });
}
// SAFETY: the stub window is a plain object this file owns; `os1` is the
// only key read through it, and it is removed again after each test.
const shell = testWindow as { os1?: unknown };

afterEach(() => {
  delete shell.os1;
});

describe("VoiceAudioSection", () => {
  test("renders nothing without the native bridge", () => {
    expect(renderToStaticMarkup(<VoiceAudioSection />)).toBe("");
  });

  test("offers the microphone, output and ducking on the Mac shell", () => {
    shell.os1 = {
      voiceAudio: {
        devices: () =>
          Promise.resolve({ inputs: [], outputs: [], advancedDucking: true }),
      },
    };
    const html = renderToStaticMarkup(<VoiceAudioSection />);
    expect(html).toContain("Microphone");
    expect(html).toContain("Output");
    expect(html).toContain('aria-label="Lower other audio during speech"');
  });
});
