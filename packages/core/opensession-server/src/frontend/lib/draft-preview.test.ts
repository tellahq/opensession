import { expect, test } from "bun:test";
import { draftPreview } from "./draft-preview";

const empty = { text: "", images: [], files: [], pastedTexts: [] };

test("draft preview flattens the text onto one line", () => {
  expect(draftPreview({ ...empty, text: "  Fix the\n\nsidebar  " })).toEqual({
    text: "Fix the sidebar",
    attachments: null,
  });
});

test("draft preview keeps only the first sentence", () => {
  expect(
    draftPreview({
      ...empty,
      text: "I couldn't get the pencil to cover the Archive icon. On hover it moved left.",
    }).text,
  ).toBe("I couldn't get the pencil to cover the Archive icon.");
  expect(
    draftPreview({ ...empty, text: "Ship v1.2 today? Then tell Sam." }).text,
  ).toBe("Ship v1.2 today?");
});

test("draft preview trims a sentence that never ends", () => {
  const { text } = draftPreview({ ...empty, text: "word ".repeat(100) });
  expect(text.endsWith("…")).toBe(true);
  expect(text.length).toBeLessThanOrEqual(201);
});

test("draft preview counts what is attached", () => {
  expect(
    draftPreview({
      ...empty,
      images: ["data:a", "data:b"],
      pastedTexts: [{ id: "p", text: "log" }],
    }),
  ).toEqual({ text: "", attachments: "2 images, 1 attachment" });
});
