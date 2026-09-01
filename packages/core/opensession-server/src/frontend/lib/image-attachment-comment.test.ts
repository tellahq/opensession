import { describe, expect, test } from "bun:test";
import {
  appendImageAttachmentComment,
  deleteImageAttachmentComment,
  imageAttachmentReference,
  parseImageAttachmentComments,
  rebaseImageAttachmentReferences,
  updateImageAttachmentComment,
} from "./image-attachment-comment";

const region = { x: 0.124, y: 0.201, width: 0.3, height: 0.4 };

describe("image attachment comments", () => {
  test("formats a compact attachment and region reference", () => {
    expect(imageAttachmentReference(1, region)).toBe(
      "[Image 2 · 12–42% × 20–60%]",
    );
  });

  test("appends multiple single-line comments without replacing the draft", () => {
    const first = appendImageAttachmentComment(
      "Intro",
      0,
      region,
      " Fix this\nheader ",
    );
    const second = appendImageAttachmentComment(first, 1, region, "And this");
    expect(second).toBe(
      "Intro\n[Image 1 · 12–42% × 20–60%] Fix this header\n[Image 2 · 12–42% × 20–60%] And this",
    );
  });

  test("parses draft comments back into image regions", () => {
    expect(
      parseImageAttachmentComments(
        "Intro\n[Image 2 · 12–42% × 20–60%] Fix this header",
      ),
    ).toEqual([
      {
        id: "6",
        imageIndex: 1,
        region: { x: 0.12, y: 0.2, width: 0.3, height: 0.39999999999999997 },
        text: "Fix this header",
        reference: "[Image 2 · 12–42% × 20–60%]",
        start: 6,
        end: 49,
      },
    ]);
  });

  test("edits one annotation in place", () => {
    const draft = "Intro\n[Image 1 · 12–42% × 20–60%] Old copy\nOutro";
    const [comment] = parseImageAttachmentComments(draft);
    expect(
      updateImageAttachmentComment(
        draft,
        comment,
        { x: 0.2, y: 0.3, width: 0.4, height: 0.5 },
        "New copy",
      ),
    ).toBe("Intro\n[Image 1 · 20–60% × 30–80%] New copy\nOutro");
  });

  test("deletes one annotation line and keeps surrounding prose", () => {
    const draft = "Intro\n[Image 1 · 12–42% × 20–60%] Remove me\nOutro";
    const [comment] = parseImageAttachmentComments(draft);
    expect(deleteImageAttachmentComment(draft, comment)).toBe("Intro\nOutro");
  });

  test("rebases later references and detaches comments from a removed image", () => {
    expect(
      rebaseImageAttachmentReferences(
        "[Image 1 · 12–42% × 20–60%] First\n[Image 2 · 12–42% × 20–60%] Second",
        0,
      ),
    ).toBe("First\n[Image 1 · 12–42% × 20–60%] Second");
  });
});
