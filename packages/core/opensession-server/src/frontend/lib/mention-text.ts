/**
 * Splitting human-written text (a team note, a prompt someone typed) into the
 * bits that render as themselves and the bits that render as something: an
 * @-mention of a teammate, or a bare URL.
 *
 * An `@word` is only a mention when it names somebody on the roster. That
 * matters because prose is full of `@` that means nothing to us — an email
 * address, a handle on another service, `@media` in quoted CSS. Rendering
 * those as a person chip would invent a teammate who does not exist, so an
 * unmatched `@word` stays plain text.
 */

import type { Person } from "./people";

export type MentionToken =
  | { kind: "text"; text: string }
  | { kind: "url"; text: string }
  /** `name` is the roster spelling, which may differ in case from the text. */
  | { kind: "mention"; text: string; name: string };

const TOKEN_RE = /(@[A-Za-z][\w.-]*|https?:\/\/[^\s<>"')\]]+)/g;

interface TrimmedMention {
  name: string;
  rest: string;
}

/** Trailing punctuation belongs to the sentence, not the name: "@Kent," */
function trimTrailing(word: string): TrimmedMention {
  const m = word.match(/^(.*?)([.,;:!?]*)$/);
  return { name: m?.[1] ?? word, rest: m?.[2] ?? "" };
}

export function parseMentions(text: string, people: Person[]): MentionToken[] {
  if (!text) return [];
  const out: MentionToken[] = [];
  const push = (token: MentionToken) => {
    const last = out[out.length - 1];
    // Keep adjacent plain runs as one token so React renders fewer nodes.
    if (token.kind === "text" && last?.kind === "text") last.text += token.text;
    else if (token.kind !== "text" || token.text) out.push(token);
  };

  for (const part of text.split(TOKEN_RE)) {
    if (!part) continue;
    if (/^https?:\/\//.test(part)) {
      push({ kind: "url", text: part });
      continue;
    }
    if (part.startsWith("@")) {
      const { name: typed, rest } = trimTrailing(part.slice(1));
      const person = people.find(
        (p) =>
          p.name.toLowerCase() === typed.toLowerCase() ||
          p.fullName.toLowerCase() === typed.toLowerCase(),
      );
      if (person) {
        push({ kind: "mention", text: `@${typed}`, name: person.name });
        if (rest) push({ kind: "text", text: rest });
        continue;
      }
    }
    push({ kind: "text", text: part });
  }
  return out;
}
