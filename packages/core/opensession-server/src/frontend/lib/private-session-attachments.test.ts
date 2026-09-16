import { describe, expect, test } from "bun:test";
import {
  PASTED_TEXT_FILE_THRESHOLD,
  shouldCollapsePastedText,
} from "./pasted-text";
import {
  PRIVATE_ATTACHMENTS_STAGED,
  PRIVATE_ATTACHMENTS_UNAVAILABLE,
  isPrivateSession,
  pastedTextBecomesFile,
  privateAttachmentsBlocked,
} from "./private-session-attachments";

const componentSource = (name: string) =>
  Bun.file(new URL(`../components/${name}`, import.meta.url)).text();

describe("private session attachments", () => {
  test("a private session is the server's access scope, never a name", () => {
    expect(
      isPrivateSession({
        accessScope: { kind: "personal", ownerGithubAccountId: 41 },
      }),
    ).toBe(true);
    expect(isPrivateSession({ accessScope: { kind: "shared" } })).toBe(false);
    expect(isPrivateSession({})).toBe(false);
    expect(isPrivateSession(null)).toBe(false);
  });

  test("only a private target with staged media blocks the send", () => {
    expect(privateAttachmentsBlocked(true, { images: 1, files: 0 })).toBe(true);
    expect(privateAttachmentsBlocked(true, { images: 0, files: 2 })).toBe(true);
    expect(privateAttachmentsBlocked(true, { images: 0, files: 0 })).toBe(
      false,
    );
    expect(privateAttachmentsBlocked(false, { images: 3, files: 1 })).toBe(
      false,
    );
  });

  test("a long paste becomes a file only for a shared target; private stays an inline chip", () => {
    const short = "x".repeat(PASTED_TEXT_FILE_THRESHOLD - 1);
    const atThreshold = "x".repeat(PASTED_TEXT_FILE_THRESHOLD);
    const huge = "y".repeat(PASTED_TEXT_FILE_THRESHOLD * 5);
    expect(pastedTextBecomesFile(false, short)).toBe(false);
    expect(pastedTextBecomesFile(false, atThreshold)).toBe(true);
    expect(pastedTextBecomesFile(false, huge)).toBe(true);
    for (const text of [short, atThreshold, huge]) {
      expect(pastedTextBecomesFile(true, text)).toBe(false);
      // The private paste is not lost: it takes the chip path, inline text
      // that travels as `pastedTexts`, never through the attachment intake.
      expect(shouldCollapsePastedText(text)).toBe(true);
    }
  });

  // The paste handlers that can stage a file must never hand a private
  // target's long paste to the attachment intake, which refuses it and would
  // drop the text. Checked on the exact source, so a restored file branch in
  // the published tree cannot come back unguarded.
  test("every paste-to-file branch in a composer is guarded for a private target", async () => {
    const branch = /shouldAttachPastedTextAsFile\(/g;
    const prompt = await componentSource("NewSessionPrompt.tsx");
    for (const match of prompt.matchAll(branch)) {
      const before = prompt.slice(Math.max(0, match.index - 80), match.index);
      // Either form: the private-aware helper, or the explicit guard.
      expect(
        /pastedTextBecomesFile\(\s*!!?privateRepo/.test(
          prompt.slice(Math.max(0, match.index - 200), match.index + 60),
        ) || /!privateRepo\s*&&\s*$/.test(before),
      ).toBe(true);
    }
    const promptGuarded = prompt.match(
      /pastedTextBecomesFile\(\s*!!?privateRepo/g,
    );
    // The helper form must import from this module, not reimplement it.
    if (promptGuarded?.length)
      expect(prompt).toContain(
        'pastedTextBecomesFile } from "../lib/private-session-attachments"',
      );

    const composer = await componentSource("Composer.tsx");
    const calls = [...composer.matchAll(branch)];
    expect(calls.length).toBeGreaterThan(0);
    for (const match of calls) {
      const before = composer.slice(Math.max(0, match.index - 40), match.index);
      expect(/canAttachFiles\s*&&\s*$/.test(before)).toBe(true);
    }
    // canAttachFiles itself is off for a private session.
    expect(composer).toMatch(
      /const canAttachFiles =[\s\S]{0,120}!attachmentsUnavailable/,
    );

    // Replacing the call with the helper must also drop the import: neither
    // the lint rules nor tsc flag an unused import here, so a published tree
    // that kept it would pass the rest of the gate carrying dead code.
    const importsBranch =
      /import\s*\{[^}]*\bshouldAttachPastedTextAsFile\b[^}]*\}/;
    for (const source of [prompt, composer]) {
      expect(importsBranch.test(source)).toBe(
        source.includes("shouldAttachPastedTextAsFile("),
      );
    }
  });

  test("copy is short, sentence case, and names the way out", () => {
    for (const copy of [
      PRIVATE_ATTACHMENTS_UNAVAILABLE,
      PRIVATE_ATTACHMENTS_STAGED,
    ]) {
      expect(copy).not.toContain("—");
      expect(copy[0]).toBe(copy[0].toUpperCase());
      expect(copy.length).toBeLessThan(100);
    }
    expect(PRIVATE_ATTACHMENTS_STAGED).toContain("shared repository");
  });
});
