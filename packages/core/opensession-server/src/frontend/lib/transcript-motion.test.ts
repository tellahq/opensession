import { expect, test } from "bun:test";
import { transcriptEnterClass } from "./transcript-motion";

test("live transcript inserts opt into restrained arrival motion only", () => {
  expect(transcriptEnterClass(true)).toContain("transcript-enter");
  expect(transcriptEnterClass(false)).toBeUndefined();
});
