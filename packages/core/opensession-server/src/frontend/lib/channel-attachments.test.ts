import { describe, expect, test } from "bun:test";
import { addAttachments, MAX_ATTACHMENTS } from "./channel-attachments";

const MB = 1024 * 1024;
const file = (name: string, size: number, type = "application/pdf") =>
  new File([new Uint8Array(size)], name, { type });
const preview = (f: File) => `blob:${f.name}`;

describe("composer attachments", () => {
  test("images get a preview, other files do not", () => {
    const { attachments, rejected } = addAttachments(
      [],
      [file("shot.png", 10, "image/png"), file("notes.pdf", 10)],
      20 * MB,
      preview,
    );
    expect(attachments.map((a) => a.url)).toEqual(["blob:shot.png", undefined]);
    expect(rejected).toBeUndefined();
  });

  test("a file over the limit stays out and is named", () => {
    const result = addAttachments(
      [],
      [file("big.mov", 3 * MB), file("ok.txt", 5)],
      2 * MB,
      preview,
    );
    expect(result.attachments.map((a) => a.file.name)).toEqual(["ok.txt"]);
    expect(result.rejected).toBe("big.mov is too large (2 MB max)");
  });

  test("stops at Slack's ten files", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) =>
      file(`f${i}.txt`, 1),
    );
    const result = addAttachments([], many, MB, preview);
    expect(result.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(result.rejected).toBe("You can attach up to 10 files");
  });
});
