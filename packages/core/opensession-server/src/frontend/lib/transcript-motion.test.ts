import { expect, test } from "bun:test";
import {
  TRANSCRIPT_ARRIVING_POSITION_CLASS,
  transcriptEnterClass,
} from "./transcript-motion";

test("live transcript inserts opt into restrained arrival motion", () => {
  expect(transcriptEnterClass(true)).toContain("transcript-enter");
  expect(transcriptEnterClass(false)).toBeUndefined();
  expect(TRANSCRIPT_ARRIVING_POSITION_CLASS).toContain("transition:transform");
});
