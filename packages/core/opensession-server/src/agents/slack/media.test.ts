import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describeSkippedMedia, splitSlackMedia } from "./media";

let root: string;
const write = (name: string, bytes = 8) => {
  const path = join(root, name);
  writeFileSync(path, "x".repeat(bytes));
  return path;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slack-media-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("splitSlackMedia", () => {
  test("leaves a reply without markers exactly as it was", () => {
    const text = "Fixed it in `NewSession.tsx`.\n\nNo screenshots this time.";
    expect(splitSlackMedia(text)).toEqual({ text, media: [], skipped: [] });
  });

  test("takes the marked files out of the text, in the order written", () => {
    const shot = write("after.png");
    const clip = write("demo.mp4");
    const split = splitSlackMedia(
      `Here is the fix.\n\nOPENSESSION_IMAGE: ${shot}\n\nAnd it moving:\n\nOPENSESSION_VIDEO: ${clip}\n`,
    );
    expect(split.media).toEqual([
      { path: shot, kind: "image" },
      { path: clip, kind: "video" },
    ]);
    expect(split.text).toBe("Here is the fix.\n\nAnd it moving:");
    expect(split.skipped).toEqual([]);
  });

  test("reads a marker an agent dressed up, and drops the whole line", () => {
    const shot = write("my_final_shot.png");
    const split = splitSlackMedia(
      `Done.\n\n**OPENSESSION_IMAGE: ${shot}**\n\nTop is now.`,
    );
    expect(split.media).toEqual([{ path: shot, kind: "image" }]);
    expect(split.text).toBe("Done.\n\nTop is now.");
  });

  test("uploads a file marked twice once", () => {
    const shot = write("pair.png");
    const split = splitSlackMedia(
      `OPENSESSION_IMAGE: ${shot}\nOPENSESSION_IMAGE: ${shot}`,
    );
    expect(split.media).toEqual([{ path: shot, kind: "image" }]);
  });

  test("names what it couldn't send rather than dropping it", () => {
    const missing = join(root, "gone.png");
    const empty = write("empty.png", 0);
    const split = splitSlackMedia(
      `OPENSESSION_IMAGE: ${missing}\nOPENSESSION_IMAGE: ${empty}`,
    );
    expect(split.media).toEqual([]);
    expect(split.skipped).toEqual([
      { path: missing, reason: "no such file on this host" },
      { path: empty, reason: "the file is empty" },
    ]);
    expect(describeSkippedMedia(split.skipped)).toBe(
      "gone.png (no such file on this host), empty.png (the file is empty)",
    );
  });

  test("skips a file over Slack's upload limit, with its size", () => {
    const big = write("huge.mp4", 1);
    truncateSync(big, 21 * 1024 * 1024);
    const split = splitSlackMedia(`OPENSESSION_VIDEO: ${big}`);
    expect(split.media).toEqual([]);
    expect(split.skipped[0]?.reason).toBe(
      "21.0 MB, over Slack's 20.0 MB upload limit",
    );
  });

  test("caps one reply at ten files", () => {
    const paths = Array.from({ length: 12 }, (_, i) => write(`shot-${i}.png`));
    const split = splitSlackMedia(
      paths.map((path) => `OPENSESSION_IMAGE: ${path}`).join("\n"),
    );
    expect(split.media).toHaveLength(10);
    expect(split.skipped).toHaveLength(2);
    expect(split.skipped[0]?.reason).toBe("over 10 files in one reply");
  });

  test("leaves a reply that was nothing but a marker with no text", () => {
    const shot = write("only.png");
    const split = splitSlackMedia(`OPENSESSION_IMAGE: ${shot}\n`);
    expect(split.text).toBe("");
    expect(split.media).toHaveLength(1);
  });
});
