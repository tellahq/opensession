import { describe, expect, test } from "bun:test";
import { askLetterFromKey, askOptionForLetter } from "./ask-shortcuts";

const bare = { metaKey: false, ctrlKey: false, altKey: false };

describe("askLetterFromKey", () => {
  test("a bare letter names an option, in either case", () => {
    expect(askLetterFromKey({ ...bare, key: "b" })).toBe("B");
    expect(askLetterFromKey({ ...bare, key: "B" })).toBe("B");
  });

  test("chords, held keys and compositions are not answers", () => {
    expect(askLetterFromKey({ ...bare, key: "b", metaKey: true })).toBeNull();
    expect(askLetterFromKey({ ...bare, key: "b", ctrlKey: true })).toBeNull();
    expect(askLetterFromKey({ ...bare, key: "b", altKey: true })).toBeNull();
    expect(askLetterFromKey({ ...bare, key: "b", repeat: true })).toBeNull();
    expect(
      askLetterFromKey({ ...bare, key: "b", isComposing: true }),
    ).toBeNull();
  });

  test("only single letters count", () => {
    expect(askLetterFromKey({ ...bare, key: "1" })).toBeNull();
    expect(askLetterFromKey({ ...bare, key: "Enter" })).toBeNull();
    expect(askLetterFromKey({ ...bare, key: " " })).toBeNull();
    expect(askLetterFromKey({ ...bare, key: "é" })).toBeNull();
  });
});

describe("askOptionForLetter", () => {
  const question = {
    question: "Pick",
    options: [{ label: "One" }, { label: "Two" }],
  };

  test("letters are positional, matching the card's labels", () => {
    expect(askOptionForLetter(question, "A")?.label).toBe("One");
    expect(askOptionForLetter(question, "B")?.label).toBe("Two");
  });

  test("a letter past the last option, or on a free-text question, is nothing", () => {
    expect(askOptionForLetter(question, "C")).toBeNull();
    expect(askOptionForLetter({ question: "Why?" }, "A")).toBeNull();
  });
});
