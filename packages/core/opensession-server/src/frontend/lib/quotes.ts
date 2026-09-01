/**
 * Quoted transcript context. A person explicitly attaches one selected
 * passage, which stays highlighted while they type; the next message goes out
 * with that passage quoted above it, so both the model and the transcript show
 * exactly what was being talked about.
 */

import { randomUUID } from "./random-uuid";

export interface Quote {
  id: string;
  text: string;
}

export function newQuote(text: string): Quote {
  return { id: randomUUID(), text: text.trim() };
}

/** A compact, single-line preview for the composer's selected-text tooltip. */
export function quotePreview(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  return compact.length > 20 ? `${compact.slice(0, 20).trimEnd()}...` : compact;
}

/**
 * The outgoing message: each staged passage as a markdown blockquote, then the
 * typed message. Markdown renders it in the sender's own bubble too, so the
 * conversation keeps the context the answer was given for.
 *
 * A staged passage never sends on its own from the UI: the composer's send
 * stays disabled until something is typed, since "chat with selected text"
 * means asking something about it. The empty-message case is still total here
 * rather than returning "": a passage is content, and a caller that hands one
 * over should get it back.
 */
export function withQuotes(quotes: Quote[], message: string): string {
  if (quotes.length === 0) return message;
  const blocks = quotes.map((q) =>
    q.text
      .split("\n")
      .map((line) => (line.trim() ? `> ${line}` : ">"))
      .join("\n"),
  );
  const typed = message.trim();
  return typed ? `${blocks.join("\n\n")}\n\n${typed}` : blocks.join("\n\n");
}
