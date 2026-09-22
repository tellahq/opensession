import { expect, test } from "bun:test";

const composer = await Bun.file(
  new URL("./PhoneDiffCommentComposer.tsx", import.meta.url),
).text();
const diff = await Bun.file(
  new URL("./CommentableDiff.tsx", import.meta.url),
).text();

test("phone composition replaces only the draft annotation, preserving desktop and pending cards", () => {
  expect(diff).toContain("isPhone && draft && files[draft.fileIndex]");
  expect(diff).toContain("isDraftFile && !isPhone");
  expect(diff).toContain('annotation.metadata?.kind === "pending"');
  expect(diff).toContain("onSubmit={submitDraft}");
  expect(diff).toContain("submitLabel={submitLabel}");
});

test("phone dismissal guards unsaved text and in-flight submission", () => {
  expect(composer).toContain("if (sending) return;");
  expect(composer).toContain("if (!text.trim()) return onCancel();");
  expect(composer).toContain('title: "Discard comment?"');
  expect(composer).toContain('cancelLabel: "Keep writing"');
  expect(composer).toContain("onConfirm: onCancel");
  expect(composer).toContain("textStore.write(event.target.value)");
});

test("phone editor uses keyboard inset, accessible close, preview and caller submission", () => {
  expect(composer).toContain("trackKeyboardInset()");
  expect(composer).toContain("pb-[var(--kb-inset,0px)]");
  expect(composer).toContain('aria-label="Close comment"');
  expect(composer).toContain('value="preview"');
  expect(composer).toContain("renderPrCommentMarkdown(text, { repo })");
  expect(composer).toContain('sending ? "Sending…" : submitLabel');
  expect(composer).toContain("await onSubmit(text.trim())");
});
