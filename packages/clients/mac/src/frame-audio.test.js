const { describe, expect, test } = require("bun:test");
const { FRAME_AUDIO_SCRIPT } = require("./frame-audio");

describe("frame audio", () => {
  test("the reporter is a self-contained script", () => {
    expect(() => new Function(FRAME_AUDIO_SCRIPT)).not.toThrow();
    expect(FRAME_AUDIO_SCRIPT).toContain("opensession:audio");
    expect(FRAME_AUDIO_SCRIPT).toContain("opensession:pause-audio");
  });
});
