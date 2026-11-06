import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceAudioOptions } from "./VoiceAudioSettings";

// `os1Shell()` reads `globalThis.window?.os1`. One process runs every test
// file, so whichever ran first may already have installed a window; add to
// it rather than replacing it, and take only our own key back out.
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

function withBridge() {
  shell.os1 = {
    voiceAudio: {
      devices: () =>
        Promise.resolve({ inputs: [], outputs: [], advancedDucking: true }),
    },
  };
}

afterEach(() => {
  delete shell.os1;
});

describe("VoiceAudioOptions", () => {
  test("renders nothing without the native bridge", () => {
    expect(renderToStaticMarkup(<VoiceAudioOptions mode="dictation" />)).toBe(
      "",
    );
  });

  test("is a menu trigger on the Mac shell", () => {
    withBridge();
    const html = renderToStaticMarkup(<VoiceAudioOptions mode="dictation" />);
    expect(html).toMatch(
      /aria-label="Dictation audio options"[^>]*aria-haspopup="menu"|aria-haspopup="menu"[^>]*aria-label="Dictation audio options"/,
    );
    expect(html).not.toContain('aria-haspopup="dialog"');
  });

  test("names the call's menu", () => {
    withBridge();
    expect(
      renderToStaticMarkup(<VoiceAudioOptions mode="conversation" />),
    ).toContain('aria-label="Call audio options"');
  });
});
