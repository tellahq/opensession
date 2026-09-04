import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "./session-control";
import {
  publishSessionFile,
  safeTransferPath,
  transferSessionFile,
} from "./session-file-transfer";

function session(id: string): SessionSummary {
  return {
    id,
    title: id,
    source: "opensession",
    lastActivity: new Date().toISOString(),
    state: "idle",
    queuedCount: 0,
    controllable: true,
    worktreeDir: `/work/${id}`,
  } as SessionSummary;
}

describe("session file transfer", () => {
  test("rejects absolute, traversal, and ambiguous paths", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "../secret",
      "a/../b",
      "a//b",
      "a\\b",
      "a\nb",
    ])
      expect(() => safeTransferPath(path)).toThrow();
    expect(safeTransferPath("./reports/result.json")).toBe(
      "reports/result.json",
    );
  });

  test("copies binary workspace data into the recipient inbox", async () => {
    let write: any;
    const data = Buffer.from([0, 1, 2, 255]);
    const result = await transferSessionFile(
      {
        fromSession: session("os-source"),
        toSession: session("os-target"),
        path: "dist/result.bin",
      },
      {
        readWorkspace: async () => data,
        write: (id, path, bytes, description) => {
          write = { id, path, bytes, description };
          return { path, size: bytes.byteLength };
        },
      },
    );
    expect(result).toEqual({
      path: "inbox/os-source/result.bin",
      size: 4,
      source: "workspace",
    });
    expect(write.id).toBe("os-target");
    expect(write.bytes).toEqual(data);
    expect(write.description).toContain("workspace:dist/result.bin");
  });

  test("can transfer an asset to an explicit destination", async () => {
    const result = await transferSessionFile(
      {
        fromSession: session("os-source"),
        toSession: session("os-target"),
        path: "diagram.png",
        source: "assets",
        destination: "references/architecture.png",
      },
      {
        readAsset: () => Buffer.from("png"),
        write: (_id, path, bytes) => ({ path, size: bytes.byteLength }),
      },
    );
    expect(result).toEqual({
      path: "references/architecture.png",
      size: 3,
      source: "assets",
    });
  });

  test("publishes an existing binary workspace file to the same session", async () => {
    const root = mkdtempSync(join(tmpdir(), "opensession-publish-"));
    const bytes = Buffer.from([0, 1, 2, 255]);
    writeFileSync(join(root, "result.docx"), bytes);
    let written: { id: string; path: string; bytes: Buffer } | undefined;
    try {
      const result = await publishSessionFile(
        {
          session: { ...session("os-source"), worktreeDir: root },
          sourcePath: "result.docx",
          destination: "exports/result.docx",
        },
        {
          write: (id, path, data) => {
            written = { id, path, bytes: data };
            return { path, size: data.byteLength };
          },
        },
      );
      expect(result).toEqual({
        path: "exports/result.docx",
        size: 4,
        source: "workspace",
      });
      expect(written).toEqual({
        id: "os-source",
        path: "exports/result.docx",
        bytes,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a workspace symlink that points outside the session", async () => {
    const root = mkdtempSync(join(tmpdir(), "opensession-publish-"));
    const outside = join(tmpdir(), `opensession-outside-${process.pid}.txt`);
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(root, "outside.txt"));
    try {
      await expect(
        publishSessionFile({
          session: { ...session("os-source"), worktreeDir: root },
          sourcePath: "outside.txt",
          destination: "outside.txt",
        }),
      ).rejects.toThrow("escapes");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  test("refuses self-transfer", async () => {
    await expect(
      transferSessionFile({
        fromSession: session("os-same"),
        toSession: session("os-same"),
        path: "file.txt",
      }),
    ).rejects.toThrow("different");
  });
});
