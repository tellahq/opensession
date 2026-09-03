import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewSessionPrompt } from "./NewSessionPrompt";
import type {
  NewSessionPromptConfig,
  NewSessionPromptHandle,
} from "../lib/new-session-prompt-types";

function field(overrides: Partial<NewSessionPromptConfig> = {}) {
  const handle = { current: null } satisfies {
    current: NewSessionPromptHandle | null;
  };
  const config: NewSessionPromptConfig = {
    initialText: "",
    repo: "opensession",
    placeholder: "What do you want to work on?",
    disabled: false,
    images: [],
    files: [],
    pastedTexts: [],
    staging: { images: 0, files: 0 },
    sendKey: "enter",
    canCreate: false,
    ...overrides,
  };
  const value = { current: "" };
  const props: Parameters<typeof NewSessionPrompt>[0] = {
    config,
    refs: {
      textarea: { current: null },
      value,
      handle,
    },
    actions: {
      removeImage: () => {},
      removeFile: () => {},
      removePendingImage: () => {},
      removePendingFile: () => {},
      addAttachments: () => {},
      addPastedText: () => {},
      removePastedText: () => {},
      create: () => {},
      changeHasText: () => {},
      settleDraft: () => {},
      changeEdges: () => {},
      changeMentionOpen: () => {},
    },
  };
  return {
    value,
    html: renderToStaticMarkup(<NewSessionPrompt {...props} />),
  };
}

test("the restored draft is what the field shows", () => {
  const { html } = field({ initialText: "Fix the flaky test" });

  expect(html).toContain("<textarea");
  expect(html).toContain("Fix the flaky test");
  expect(html).toContain('placeholder="What do you want to work on?"');
});

// Rendering can be abandoned under concurrent React, so the external ref is
// updated by a layout effect only after the draft commits.
test("a server render does not publish an uncommitted draft", () => {
  const { value } = field({ initialText: "Ship the palette split" });

  expect(value.current).toBe("");
});

test("attachments share the prompt's scroller", () => {
  const { html } = field({
    images: ["data:image/png;base64,iVBORw0KGgo="],
    files: [
      {
        name: "notes.txt",
        type: "text/plain",
        dataUrl: "data:text/plain;base64,aGk=",
      },
    ],
  });

  expect(html).toContain('aria-label="Open image preview"');
  expect(html).toContain("notes.txt");
  expect(html.indexOf('aria-label="Open image preview"')).toBeGreaterThan(
    html.indexOf("<textarea"),
  );
});

test("image annotation references use the same highlighted token as the composer", () => {
  const { html } = field({
    initialText: "[Image 1 · 12–48% × 20–60%] Increase the contrast",
    images: ["data:image/png;base64,iVBORw0KGgo="],
  });

  expect(html).toContain("cmp-image-attachment");
  expect(html).toContain("[Image 1 · 12–48% × 20–60%]");
});

// A pasted screenshot is uploaded before it is attached, and during a slow
// load that takes seconds. Without something standing in for it the card
// looks like it ignored the paste, and the second paste leaves you with two
// of the same picture.
test("an image still being staged holds its place", () => {
  const { html } = field({ staging: { images: 1, files: 0 } });

  // The tile itself, in the row the picture will land in.
  expect(html).toContain("animate-pulse");
  expect(html).toContain('aria-label="Cancel image upload"');
  // And the same news for a reader who cannot see it.
  expect(html).toContain("Attaching 1 image…");
  expect(html).toContain('role="status"');
});

test("a staged file holds its place too", () => {
  const { html } = field({ staging: { images: 0, files: 1 } });

  expect(html).toContain("animate-pulse");
  expect(html).toContain('aria-label="Cancel file upload"');
  expect(html).toContain("Attaching 1 file…");
});

test("a staged image's ghost does not survive its arrival", () => {
  const { html } = field({
    images: ["data:image/png;base64,iVBORw0KGgo="],
    staging: { images: 0, files: 0 },
  });

  expect(html).not.toContain("animate-pulse");
  expect(html).not.toContain("Attaching");
});

test("a busy create disables the field", () => {
  const { html } = field({ disabled: true });

  expect(html).toContain("disabled");
});
