import { mergeStylexProps } from "../ui/cn";
import React from "react";
import { parseMentions } from "../lib/mention-text";
import { usePeople } from "../lib/people";
import { githubLoginFor } from "./UserAvatar";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  underline: {
    textDecorationLine: "underline",
  },
  decorationAccent40: {
    textDecorationColor: "color-mix(in oklab, var(--accent) 40%, transparent)",
  },
  underlineOffset2: {
    textUnderlineOffset: "2px",
  },
  hoverDecorationAccent: {
    "@media (hover: hover)": {
      ":hover": {
        textDecorationColor: "var(--accent)",
      },
    },
  },
});

/**
 * Plain human text with @-mentions rendered as the person they name. Team
 * notes are plain text, not markdown, so they can't go through the renderer
 * that mints these chips for prompts and answers (markdown.ts) — this is the
 * same chip for the plain-text surface. It deliberately reuses the
 * `person-chip` classes from base.css so the two paths cannot drift apart, and
 * the click is handled by the same document-level listener in App.tsx.
 *
 * Only names on the roster become chips (lib/mention-text.ts); an unmatched
 * `@word` stays prose.
 */
export function MentionText({ text }: { text: string }) {
  const people = usePeople();
  const tokens = parseMentions(text, people);
  if (!tokens.length) return null;

  return (
    <>
      {tokens.map((token, i) => {
        if (token.kind === "url")
          return (
            <a
              key={i}
              href={token.text}
              target="_blank"
              rel="noreferrer"
              {...mergeStylexProps(
                "text-accent",
                sx.underline,
                sx.decorationAccent40,
                sx.underlineOffset2,
                sx.hoverDecorationAccent,
              )}
            >
              {token.text}
            </a>
          );
        if (token.kind === "mention") {
          const login = githubLoginFor(token.name);
          return (
            <a
              key={i}
              role="button"
              tabIndex={0}
              className="person-chip"
              data-person={token.name}
              title={`Show ${token.name}'s sidebar`}
            >
              {login ? (
                <img
                  className="person-chip-face"
                  src={`https://github.com/${login}.png?size=36`}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span
                  className="person-chip-face person-chip-initial"
                  aria-hidden="true"
                >
                  {token.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span>{token.name}</span>
            </a>
          );
        }
        return <React.Fragment key={i}>{token.text}</React.Fragment>;
      })}
    </>
  );
}
