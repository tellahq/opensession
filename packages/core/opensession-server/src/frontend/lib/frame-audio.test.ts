import { expect, test } from "bun:test";
import { FRAME_AUDIO_MESSAGE, frameAudioReport } from "./frame-audio";

// SAFETY: the report only compares the source by identity.
const frame = {} as Window;
// SAFETY: as above.
const other = {} as Window;

test("reads the frame's audible state", () => {
  expect(
    frameAudioReport(
      { data: { type: FRAME_AUDIO_MESSAGE, audible: true }, source: frame },
      frame,
    ),
  ).toBe(true);
  expect(
    frameAudioReport(
      { data: { type: FRAME_AUDIO_MESSAGE, audible: false }, source: frame },
      frame,
    ),
  ).toBe(false);
});

test("ignores other windows and other messages", () => {
  expect(
    frameAudioReport(
      { data: { type: FRAME_AUDIO_MESSAGE, audible: true }, source: other },
      frame,
    ),
  ).toBeNull();
  expect(
    frameAudioReport(
      { data: { type: FRAME_AUDIO_MESSAGE, audible: "yes" }, source: frame },
      frame,
    ),
  ).toBeNull();
  expect(frameAudioReport({ data: "hello", source: frame }, frame)).toBeNull();
  expect(
    frameAudioReport(
      { data: { type: FRAME_AUDIO_MESSAGE, audible: true }, source: frame },
      null,
    ),
  ).toBeNull();
});
