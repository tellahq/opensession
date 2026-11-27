import { expect, test } from "bun:test";
import { draftPreview } from "./draft-preview";

const empty = { text: "", images: [], files: [], pastedTexts: [] };

test("draft preview flattens the text onto one line", () => {
  expect(draftPreview({ ...empty, text: "  Fix the\n\nsidebar  " })).toEqual({
    text: "Fix the sidebar",
    attachments: null,
  });
});

test("draft preview trims a long draft", () => {
  const { text } = draftPreview({ ...empty, text: "word ".repeat(100) });
  expect(text.endsWith("…")).toBe(true);
  expect(text.length).toBeLessThanOrEqual(281);
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
