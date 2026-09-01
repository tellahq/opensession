import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store's directory is resolved at module load (stateDir), so the scratch
// namespace has to be in place BEFORE session-notes is imported — hence the
// dynamic import below rather than a static one. `bun test` shares one process
// across files, so the env is restored immediately afterwards.
const SCRATCH = mkdtempSync(join(tmpdir(), "session-notes-"));
const saved = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = SCRATCH;
const {
  addSessionNote,
  deleteSessionNote,
  editSessionNote,
  isValidNoteSession,
  listSessionNotes,
  sessionNoteActivity,
} = await import("./session-notes");
const { stageInlineImages } = await import("./uploads");
if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
else process.env.OPENSESSION_STATE_DIR = saved;

describe("session notes", () => {
  test("appends and lists in order, per session", () => {
    addSessionNote("os-a", "Kent", "first");
    addSessionNote("os-a", "Michiel", "second");
    addSessionNote("os-b", "Kent", "elsewhere");
    expect(listSessionNotes("os-a").map((n) => n.text)).toEqual([
      "first",
      "second",
    ]);
    expect(listSessionNotes("os-b").map((n) => n.text)).toEqual(["elsewhere"]);
    expect(listSessionNotes("os-never-written")).toEqual([]);
  });

  test("an empty note is not stored", () => {
    expect(addSessionNote("os-empty", "Kent", "   ")).toBeNull();
    expect(listSessionNotes("os-empty")).toEqual([]);
  });

  test("stores images with text and allows image-only notes", () => {
    const image = "/media?path=%2Ftmp%2Fnote.png";
    const withText = addSessionNote("os-images", "Kent", "look", [image]);
    const imageOnly = addSessionNote("os-images", "Kent", "", [image]);
    expect(withText?.images).toEqual([image]);
    expect(imageOnly?.text).toBe("");
    expect(imageOnly?.images).toEqual([image]);
  });

  test("stages inline image bytes outside the note store and removes them with the note", () => {
    const urls = stageInlineImages(
      "os-staged-image",
      ["data:image/png;base64,iVBORw0KGgo="],
      "session-notes",
    );
    const path = new URL(urls[0]!, "http://local").searchParams.get("path")!;
    expect(existsSync(path)).toBe(true);
    const note = addSessionNote("os-staged-image", "Kent", "", urls)!;
    expect(note.images?.[0]).toStartWith("/media?path=");
    expect(deleteSessionNote("os-staged-image", note.id, "Kent").ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("rejects unsupported and excessive inline images", () => {
    expect(() =>
      stageInlineImages("os-bad-image", ["data:image/svg+xml;base64,PHN2Zz4="]),
    ).toThrow("unsupported image type");
    expect(() =>
      stageInlineImages(
        "os-too-many-images",
        Array(7).fill("data:image/png;base64,iVBORw0KGgo="),
      ),
    ).toThrow("too many images");
  });

  test("activity reports the latest note per session", () => {
    const activity = sessionNoteActivity();
    const a = activity.find((s) => s.sessionId === "os-a");
    expect(a?.lastUser).toBe("Michiel");
    expect(a?.lastTs).toBeGreaterThan(0);
  });

  test("only path-safe session ids are accepted", () => {
    expect(isValidNoteSession("os-019ff497-a325-7000")).toBe(true);
    expect(isValidNoteSession("../../etc/passwd")).toBe(false);
    expect(isValidNoteSession("os a")).toBe(false);
    expect(isValidNoteSession("")).toBe(false);
    expect(isValidNoteSession(42)).toBe(false);
  });

  test("only the author can edit a note", () => {
    const note = addSessionNote("os-owned", "Kent", "mine")!;
    expect(editSessionNote("os-owned", note.id, "changed", "Michiel")).toEqual({
      ok: false,
      reason: "not_author",
    });
    expect(listSessionNotes("os-owned")[0]!.text).toBe("mine");
    // Case and surrounding space don't decide authorship.
    const ok = editSessionNote("os-owned", note.id, "changed", " kent ");
    expect(ok.ok).toBe(true);
    expect(listSessionNotes("os-owned")[0]!.text).toBe("changed");
    expect(listSessionNotes("os-owned")[0]!.editedAt).toBeGreaterThan(0);
  });

  test("only the author can delete a note", () => {
    const note = addSessionNote("os-del", "Kent", "mine")!;
    expect(deleteSessionNote("os-del", note.id, "Michiel")).toEqual({
      ok: false,
      reason: "not_author",
    });
    expect(listSessionNotes("os-del")).toHaveLength(1);
    expect(deleteSessionNote("os-del", note.id, "Kent").ok).toBe(true);
    expect(listSessionNotes("os-del")).toEqual([]);
  });

  test("a missing note is not_found, not not_author", () => {
    expect(deleteSessionNote("os-del", "nope", "Kent")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(editSessionNote("os-del", "nope", "x", "Kent")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
