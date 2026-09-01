import { describe, expect, test } from "bun:test";
import { LiveTextBuffer } from "./live-text";

describe("LiveTextBuffer with block ids", () => {
  test("a landed block leaves the bubble, whole or half-streamed", () => {
    const buffer = new LiveTextBuffer();
    buffer.append("The main constraint ", "prt_1");
    buffer.append("is decisive. ", "prt_1");
    // The durable entry lands while the block is still being written.
    buffer.land(
      "The main constraint is decisive. It cannot host agents.",
      "prt_1",
    );
    expect(buffer.text).toBe("");
    // The frames still in flight for it are the entry's own text.
    buffer.append("It cannot host agents.", "prt_1");
    expect(buffer.text).toBe("");
  });

  test("keeps the blocks that have not landed", () => {
    const buffer = new LiveTextBuffer();
    buffer.append("First block. ", "prt_1");
    buffer.append("Second block. ", "prt_2");
    buffer.land("First block. ", "prt_1");
    expect(buffer.text).toBe("Second block. ");
  });

  test("a normalized entry still cancels its block", () => {
    // The wire strips media markers and clamps giant entries, so the durable
    // text is not always the streamed text character for character. The id is.
    const buffer = new LiveTextBuffer();
    buffer.append(
      "Here is the clip.\nOPENSESSION_VIDEO: /tmp/a.mp4\n",
      "prt_1",
    );
    buffer.land("Here is the clip.", "prt_1");
    expect(buffer.text).toBe("");
  });

  test("reset drops everything a finished turn was tracking", () => {
    const buffer = new LiveTextBuffer();
    buffer.append("text", "prt_1");
    buffer.land("landed elsewhere", "prt_9");
    buffer.reset();
    buffer.append("text", "prt_1");
    expect(buffer.text).toBe("text");
  });
});

describe("LiveTextBuffer without block ids", () => {
  test("subtracts a landed block that streamed whole", () => {
    const buffer = new LiveTextBuffer();
    buffer.append("First block. ");
    buffer.append("Second block. ");
    buffer.land("First block. ");
    expect(buffer.text).toBe("Second block. ");
  });

  test("clears a half-streamed block and swallows its tail", () => {
    const buffer = new LiveTextBuffer();
    buffer.append("The main constraint ");
    buffer.land("The main constraint is decisive.");
    expect(buffer.text).toBe("");
    buffer.append("is ");
    buffer.append("decisive.");
    expect(buffer.text).toBe("");
  });

  test("swallows a block that lands before any of it streamed", () => {
    const buffer = new LiveTextBuffer();
    buffer.land("A whole block.");
    buffer.append("A whole block.");
    expect(buffer.text).toBe("");
  });

  test("an id-less copy of an id-named block is still cancelled", () => {
    // What a feed snapshot replays: the whole active bubble as one anonymous
    // run of text, which then has to survive its entry landing.
    const buffer = new LiveTextBuffer();
    buffer.append("Replayed block. ");
    buffer.land("Replayed block. ", "prt_1");
    expect(buffer.text).toBe("");
  });
});
