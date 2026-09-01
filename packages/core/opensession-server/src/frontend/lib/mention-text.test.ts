import { describe, expect, test } from "bun:test";
import { parseMentions } from "./mention-text";
import type { Person } from "./people";

const PEOPLE: Person[] = [
  { name: "Kent", fullName: "Kent de Bruin" },
  { name: "Grant", fullName: "Grant Fletcher" },
];

describe("parseMentions", () => {
  test("turns a roster name into a mention and leaves the prose alone", () => {
    expect(parseMentions("hey @Kent look", PEOPLE)).toEqual([
      { kind: "text", text: "hey " },
      { kind: "mention", text: "@Kent", name: "Kent" },
      { kind: "text", text: " look" },
    ]);
  });

  test("matches case-insensitively but reports the roster spelling", () => {
    const [token] = parseMentions("@kent", PEOPLE);
    expect(token).toEqual({ kind: "mention", text: "@kent", name: "Kent" });
  });

  test("an @word that is nobody stays plain text", () => {
    // The case that makes a naive highlighter invent teammates: an email
    // address, another service's handle, quoted CSS.
    for (const text of ["mail me@example.com", "@media (hover)", "@nobody"]) {
      expect(parseMentions(text, PEOPLE).every((t) => t.kind === "text")).toBe(
        true,
      );
    }
  });

  test("trailing punctuation belongs to the sentence", () => {
    expect(parseMentions("ping @Kent, please", PEOPLE)).toEqual([
      { kind: "text", text: "ping " },
      { kind: "mention", text: "@Kent", name: "Kent" },
      { kind: "text", text: ", please" },
    ]);
  });

  test("full names match too", () => {
    const [token] = parseMentions("@Kent de Bruin", PEOPLE);
    // "@Kent" matches first — the token stops at the space, which is what a
    // mention inserted by the composer looks like anyway.
    expect(token).toEqual({ kind: "mention", text: "@Kent", name: "Kent" });
  });

  test("URLs are their own token", () => {
    expect(parseMentions("see https://tella.tv/x now", PEOPLE)).toEqual([
      { kind: "text", text: "see " },
      { kind: "url", text: "https://tella.tv/x" },
      { kind: "text", text: " now" },
    ]);
  });

  test("adjacent plain runs collapse into one token", () => {
    expect(parseMentions("plain text, no tokens", PEOPLE)).toHaveLength(1);
    expect(parseMentions("", PEOPLE)).toEqual([]);
  });

  test("an empty roster mentions nobody", () => {
    expect(parseMentions("@Kent", []).every((t) => t.kind === "text")).toBe(
      true,
    );
  });
});
