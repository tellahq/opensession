import { expect, test } from "bun:test";
import { voiceAudioEnergy } from "./session-voice-audio";

test("silent input rests and recorded amplitude drives a bounded level", () => {
  expect(voiceAudioEnergy(new Uint8Array())).toBe(0);
  expect(voiceAudioEnergy(new Uint8Array([128, 128, 128, 128]))).toBe(0);
  const quiet = voiceAudioEnergy(new Uint8Array([126, 130, 126, 130]));
  const loud = voiceAudioEnergy(new Uint8Array([100, 156, 100, 156]));
  expect(quiet).toBeGreaterThan(0);
  expect(loud).toBeGreaterThan(quiet);
  expect(voiceAudioEnergy(new Uint8Array([0, 255]))).toBe(1);
});
