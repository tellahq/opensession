import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlainEntryRow } from "./PlainThreadPanel";
import type { PlainTimelineEntry } from "../lib/types";

// MarkdownBody reads the theme preference while rendering, and lib/theme keeps
// that in localStorage. Same stub as WalkthroughCard.test.tsx, including the
// `??=`: one process, so whichever test file ran first may already have
// installed (and frozen) these globals.
const storage = globalThis.localStorage ?? {};
Object.assign(storage, {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});
if (!globalThis.localStorage) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
    writable: true,
  });
}

const testWindow = globalThis.window ?? {};
Object.assign(testWindow, {
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});
if (!globalThis.window) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
    writable: true,
  });
}

/**
 * A support message is prose a person wrote, so it renders as markdown and its
 * pictures open in the app's lightbox rather than as a raw file in a new tab.
 * These pin both, plus the two things that must NOT follow from routing
 * customer text through the shared renderer: pasted HTML stays literal, and a
 * bare `#123` stays a ticket number.
 */

function entry(over: Partial<PlainTimelineEntry> = {}): PlainTimelineEntry {
  return {
    id: "e1",
    timestamp: "2026-08-19T10:00:00.000Z",
    actorName: "Ada Lovelace",
    actorType: "customer",
    kind: "email",
    text: "hello",
    ...over,
  };
}

test("a customer's **test** is bold, not asterisks", () => {
  const html = renderToStaticMarkup(
    <PlainEntryRow entry={entry({ text: "so **test** should be bold" })} />,
  );

  expect(html).toContain("<strong>test</strong>");
  expect(html).not.toContain("**test**");
});

test("our own replies and internal notes render markdown too", () => {
  const reply = renderToStaticMarkup(
    <PlainEntryRow
      entry={entry({ actorType: "support", text: "**shipped** it" })}
    />,
  );
  const note = renderToStaticMarkup(
    <PlainEntryRow entry={entry({ kind: "note", text: "**heads up**" })} />,
  );

  expect(reply).toContain("<strong>shipped</strong>");
  expect(note).toContain("<strong>heads up</strong>");
});

test("an email's hard line breaks survive without doubling them", () => {
  const html = renderToStaticMarkup(
    <PlainEntryRow entry={entry({ text: "line one\nline two" })} />,
  );

  // `breaks: true` on the shared renderer turns the newline into a <br>, so
  // the body must not ALSO be whitespace-pre-wrap or every break lands twice.
  expect(html).toContain("<br>");
  expect(html).not.toContain("whitespace-pre-wrap");
});

test("HTML a customer pastes stays literal text", () => {
  const html = renderToStaticMarkup(
    <PlainEntryRow entry={entry({ text: '<img src=x onerror="alert(1)">' })} />,
  );

  // The word survives as escaped text, which is the point: it is shown, not
  // parsed. What must not appear is a real tag carrying a real handler.
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('onerror="alert(1)"');
});

test("a bare #123 in a customer's mail is not linked to our repo", () => {
  const html = renderToStaticMarkup(
    <PlainEntryRow entry={entry({ text: "my order #123 never arrived" })} />,
  );

  expect(html).toContain("#123");
  expect(html).not.toContain("<a");
});

test("image attachments carry the classes the shared lightbox watches for", () => {
  const html = renderToStaticMarkup(
    <PlainEntryRow
      entry={entry({
        text: "see the screenshot",
        attachments: [
          {
            id: "att_1",
            fileName: "broken.png",
            mimeType: "image/png",
            sizeBytes: 12_345,
          },
        ],
      })}
    />,
  );

  // MediaLightbox's delegated handler matches exactly these two selectors,
  // and GALLERY_SELECTOR browses across every img.md-image on screen.
  expect(html).toContain("md-image-link");
  expect(html).toContain("md-image ");
  // The filename is what captions the viewer.
  expect(html).toContain('alt="broken.png"');
  // The wrapper already draws the surface; the transcript image's own border
  // and margin would double it.
  expect(html).toContain("border-0");
});

test("a non-image attachment stays a download chip", () => {
  const html = renderToStaticMarkup(
    <PlainEntryRow
      entry={entry({
        attachments: [
          {
            id: "att_2",
            fileName: "logs.zip",
            mimeType: "application/zip",
            sizeBytes: 2048,
          },
        ],
      })}
    />,
  );

  expect(html).toContain("logs.zip");
  expect(html).not.toContain("md-image");
});
