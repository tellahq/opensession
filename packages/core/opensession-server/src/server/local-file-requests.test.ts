import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = mkdtempSync(join(tmpdir(), "local-files-"));
const saved = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = SCRATCH;
const {
  answerLocalFilesRequest,
  declineLocalFilesRequest,
  pendingLocalFilesRequest,
  requestLocalFiles,
} = await import("./local-file-requests");
if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
else process.env.OPENSESSION_STATE_DIR = saved;

function uploads() {
  const dir = mkdtempSync(join(SCRATCH, "uploads-"));
  mkdirSync(`${dir}/staged`);
  return dir;
}

describe("local file requests", () => {
  test("waits for the person and hands the agent session-owned paths", async () => {
    const dir = uploads();
    writeFileSync(`${dir}/staged/interview.mov`, "video");
    writeFileSync(`${dir}/staged/notes.txt`, "notes");
    const waiting = requestLocalFiles("s-provide", {
      purpose: "The raw interview‮ recording",
      hint: "Desktop",
    });
    const request = pendingLocalFilesRequest("s-provide")!;
    expect(request.purpose).toBe("The raw interview  recording");
    expect(request.multiple).toBe(true);
    await answerLocalFilesRequest(
      "s-provide",
      request.id,
      [
        { name: "interview.mov", path: `${dir}/staged/interview.mov` },
        { name: "notes.txt", path: `${dir}/staged/notes.txt` },
      ],
      dir,
    );
    const result = await waiting;
    expect(result.status).toBe("provided");
    if (result.status !== "provided") return;
    expect(result.files.map((f) => [f.name, f.size])).toEqual([
      ["interview.mov", 5],
      ["notes.txt", 5],
    ]);
    const target = `${dir}/s-provide/requested/${request.id}/interview.mov`;
    expect(result.files[0]!.path).toBe(target);
    expect(await readFile(target, "utf8")).toBe("video");
    expect(existsSync(`${dir}/staged/interview.mov`)).toBe(false);
    expect(pendingLocalFilesRequest("s-provide")).toBeNull();
  });

  test("refuses paths outside the staged uploads", async () => {
    const dir = uploads();
    writeFileSync(`${dir}/secret.txt`, "no");
    const waiting = requestLocalFiles("s-escape", { purpose: "Anything" });
    const { id } = pendingLocalFilesRequest("s-escape")!;
    await expect(
      answerLocalFilesRequest(
        "s-escape",
        id,
        [{ name: "x", path: `${dir}/staged/../secret.txt` }],
        dir,
      ),
    ).rejects.toThrow("is not an uploaded file");
    // A failed answer leaves the request open for a real one.
    expect(pendingLocalFilesRequest("s-escape")?.id).toBe(id);
    expect(declineLocalFilesRequest("s-escape", id)).toBe(true);
    expect(await waiting).toEqual({ status: "declined" });
  });

  test("single-file requests take one file", async () => {
    const dir = uploads();
    writeFileSync(`${dir}/staged/a`, "a");
    writeFileSync(`${dir}/staged/b`, "b");
    const waiting = requestLocalFiles("s-one", {
      purpose: "One file",
      multiple: false,
    });
    const { id } = pendingLocalFilesRequest("s-one")!;
    await expect(
      answerLocalFilesRequest(
        "s-one",
        id,
        [
          { name: "a", path: `${dir}/staged/a` },
          { name: "b", path: `${dir}/staged/b` },
        ],
        dir,
      ),
    ).rejects.toThrow("Choose the files");
    declineLocalFilesRequest("s-one", id);
    await waiting;
  });

  test("one open request per session, and it expires", async () => {
    const waiting = requestLocalFiles(
      "s-expire",
      { purpose: "Soon" },
      undefined,
      20,
    );
    expect(() => requestLocalFiles("s-expire", { purpose: "Again" })).toThrow(
      "already has an open file request",
    );
    expect(await waiting).toEqual({ status: "expired" });
    expect(pendingLocalFilesRequest("s-expire")).toBeNull();
  });

  test("a cancelled tool call closes the card", async () => {
    const controller = new AbortController();
    const waiting = requestLocalFiles(
      "s-abort",
      { purpose: "Anything" },
      controller.signal,
    );
    controller.abort();
    expect(await waiting).toEqual({ status: "declined" });
    expect(pendingLocalFilesRequest("s-abort")).toBeNull();
  });

  test("a request needs a purpose", () => {
    expect(() => requestLocalFiles("s-empty", { purpose: "  " })).toThrow(
      "say what the files are for",
    );
  });
});
