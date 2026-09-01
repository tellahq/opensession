import { afterEach, describe, expect, test } from "bun:test";
import {
  BlockFlusher,
  TextPartStream,
  safeFlushLength,
  streamPartialTextEnabled,
} from "./stream-text";

const originalKillSwitch = process.env.OPENSESSION_OC_STREAM_TEXT;

afterEach(() => {
  if (originalKillSwitch === undefined)
    delete process.env.OPENSESSION_OC_STREAM_TEXT;
  else process.env.OPENSESSION_OC_STREAM_TEXT = originalKillSwitch;
});

describe("TextPartStream", () => {
  test("walks a growing part forward, emitting each tail once", () => {
    const stream = new TextPartStream();
    expect(stream.tail("p1", "Hel")).toBe("Hel");
    expect(stream.tail("p1", "Hello")).toBe("lo");
    expect(stream.tail("p1", "Hello there")).toBe(" there");
  });

  test("emits nothing when a part has not grown", () => {
    const stream = new TextPartStream();
    expect(stream.tail("p1", "same")).toBe("same");
    expect(stream.tail("p1", "same")).toBe("");
    expect(stream.tail("p1", "")).toBe("");
  });

  test("deltas plus the completion tail equal the finished text exactly", () => {
    // The load-bearing invariant: run-session sums text_chunk into the turn's
    // assistant text, so a re-sent prefix duplicates and a lost tail truncates.
    const stream = new TextPartStream();
    const final = "The quick brown fox jumps over the lazy dog";
    const emitted: string[] = [];
    for (let i = 4; i < final.length; i += 7) {
      emitted.push(stream.tail("p1", final.slice(0, i)));
    }
    emitted.push(stream.tail("p1", final)); // completion
    expect(emitted.join("")).toBe(final);
  });

  test("counts engine deltas so completion only says the remainder", () => {
    // The real shape of a turn: message.part.delta carries the text as it is
    // written, then message.part.updated publishes the finished part. Saying
    // the whole part again at the end would double the reply.
    const stream = new TextPartStream();
    const final = "Hello there, world";
    const sent: string[] = [];
    sent.push(stream.advance("p1", "Hello "));
    sent.push(stream.advance("p1", "there, "));
    sent.push(stream.tail("p1", final)); // the completion snapshot
    expect(sent.join("")).toBe(final);
    expect(sent.at(-1)).toBe("world");
  });

  test("a fully streamed part adds nothing at completion", () => {
    const stream = new TextPartStream();
    stream.advance("p1", "all of it");
    expect(stream.tail("p1", "all of it")).toBe("");
  });

  test("ignores empty and non-string deltas", () => {
    const stream = new TextPartStream();
    expect(stream.advance("p1", "")).toBe("");
    expect(stream.advance("p1", undefined)).toBe("");
    expect(stream.advance("p1", 42)).toBe("");
    // None of that counted, so the whole text still has to go out.
    expect(stream.tail("p1", "real text")).toBe("real text");
  });

  test("a part whose deltas were all dropped yields its whole text at completion", () => {
    // The fail-closed path: a delta for a part the mirror could not place is
    // dropped, so the completion snapshot is what delivers it, whole. That is
    // exactly the behaviour that shipped before streaming existed.
    const stream = new TextPartStream();
    expect(stream.tail("p1", "a whole block")).toBe("a whole block");
  });

  test("stops emitting when a part shrinks instead of re-sending text", () => {
    const stream = new TextPartStream();
    expect(stream.tail("p1", "abcdef")).toBe("abcdef");
    // A rewritten or re-delivered part: nothing can un-say what already went
    // out, so the durable entry is left to correct it.
    expect(stream.tail("p1", "abc")).toBe("");
    expect(stream.tail("p1", "abcdef")).toBe("");
  });

  test("tracks parts independently and releases them on done", () => {
    const stream = new TextPartStream();
    stream.tail("p1", "first");
    stream.tail("p2", "second");
    expect(stream.size).toBe(2);
    expect(stream.tail("p2", "second block")).toBe(" block");
    stream.done("p1");
    stream.done("p2");
    expect(stream.size).toBe(0);
    // A recycled id starts clean.
    expect(stream.tail("p1", "first")).toBe("first");
  });
});

describe("safeFlushLength", () => {
  const flushed = (text: string) => text.slice(0, safeFlushLength(text));

  test("cuts at the end of a sentence, not mid-word", () => {
    expect(flushed("The main constraint is decisive. It canno")).toBe(
      "The main constraint is decisive. ",
    );
  });

  test("holds a sentence whose code span has not closed", () => {
    expect(
      flushed("The main constraint is decisive: `celld actors coordinate. So"),
    ).toBe("");
    expect(
      flushed("The main constraint is decisive: `celld` actors coordinate. So"),
    ).toBe("The main constraint is decisive: `celld` actors coordinate. ");
  });

  test("holds a half-written link until its destination closes", () => {
    expect(flushed("See [the writeup. Next")).toBe("");
    expect(flushed("See [the writeup](https://x.test). Next")).toBe(
      "See [the writeup](https://x.test). ",
    );
  });

  test("holds a half-written bold run", () => {
    expect(flushed("This is **important. And")).toBe("");
    expect(flushed("This is **important**. And")).toBe(
      "This is **important**. ",
    );
  });

  test("does not cut after an abbreviation", () => {
    expect(flushed("Rendering is throttled, e.g. per frame, which")).toBe("");
  });

  test("cuts at a completed line, and at a blank line between blocks", () => {
    expect(flushed("- one\n- two\n- thr")).toBe("- one\n- two\n");
    expect(flushed("A paragraph\n\n## A hea")).toBe("A paragraph\n\n");
  });

  test("holds a fence opener, then releases whole code lines", () => {
    expect(flushed("```ts\n")).toBe("");
    expect(flushed("```ts\nconst a = 1;\n")).toBe("```ts\nconst a = 1;\n");
    // A backtick inside the fence is code, not an open span.
    expect(flushed("```ts\nconst a = `x`;\nconst b = 2;\n")).toBe(
      "```ts\nconst a = `x`;\nconst b = 2;\n",
    );
    expect(flushed("```ts\nconst a = 1;\n```\nAfter")).toBe(
      "```ts\nconst a = 1;\n```\n",
    );
  });

  test("a sentence inside a fence is not a boundary", () => {
    expect(flushed("```\nsome. text without a newline")).toBe("");
  });

  test("underscores are not emphasis", () => {
    expect(flushed("Call safe_flush_length here. Then")).toBe(
      "Call safe_flush_length here. ",
    );
  });

  test("an escaped backtick does not open a span", () => {
    expect(flushed("A \\` literal backtick. Then")).toBe(
      "A \\` literal backtick. ",
    );
  });
});

describe("BlockFlusher", () => {
  test("emits whole sentences and holds the rest", () => {
    const flusher = new BlockFlusher();
    expect(flusher.push("p1", "One correction")).toBe("");
    expect(flusher.push("p1", " to what I said. And then")).toBe(
      "One correction to what I said. ",
    );
    expect(flusher.push("p1", " some more.")).toBe("");
    expect(flusher.push("p1", " Done. ")).toBe("And then some more. Done. ");
  });

  test("what it holds plus the part's tail is the whole block", () => {
    const flusher = new BlockFlusher();
    const stream = new TextPartStream();
    const deltas = [
      "A first line.",
      " Then a `span",
      "` that closes.",
      " Tail with no end",
    ];
    let sent = "";
    for (const delta of deltas) {
      const piece = stream.advance("p1", flusher.push("p1", delta));
      sent += piece;
    }
    const whole = deltas.join("");
    expect(whole.startsWith(sent)).toBe(true);
    expect(sent).not.toBe(whole);
    // Completion says exactly the remainder, so the two concatenate to the block.
    flusher.clear("p1");
    expect(sent + stream.tail("p1", whole)).toBe(whole);
  });

  test("tracks parts independently and releases them on clear", () => {
    const flusher = new BlockFlusher();
    flusher.push("p1", "held");
    flusher.push("p2", "also held");
    expect(flusher.size).toBe(2);
    flusher.clear("p1");
    flusher.clear("p2");
    expect(flusher.size).toBe(0);
  });
});

describe("streamPartialTextEnabled", () => {
  test("streams by default, like the codex-direct adapter", () => {
    delete process.env.OPENSESSION_OC_STREAM_TEXT;
    expect(streamPartialTextEnabled()).toBe(true);
  });

  test("only the exact kill switch turns it off", () => {
    process.env.OPENSESSION_OC_STREAM_TEXT = "0";
    expect(streamPartialTextEnabled()).toBe(false);
    process.env.OPENSESSION_OC_STREAM_TEXT = "1";
    expect(streamPartialTextEnabled()).toBe(true);
    process.env.OPENSESSION_OC_STREAM_TEXT = "off";
    expect(streamPartialTextEnabled()).toBe(true);
  });

  test("is read per call, not pinned at module load", () => {
    delete process.env.OPENSESSION_OC_STREAM_TEXT;
    expect(streamPartialTextEnabled()).toBe(true);
    process.env.OPENSESSION_OC_STREAM_TEXT = "0";
    expect(streamPartialTextEnabled()).toBe(false);
  });
});
