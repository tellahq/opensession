import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = mkdtempSync(join(tmpdir(), "chunked-uploads-"));
const saved = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = SCRATCH;
const {
  UPLOAD_CHUNK_BYTES,
  UploadError,
  cancelUpload,
  completeUpload,
  createUpload,
  uploadStatus,
  writeChunk,
} = await import("./chunked-uploads");
if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
else process.env.OPENSESSION_STATE_DIR = saved;

const GIB = 1024 * 1024 * 1024;

function newStore(free = 100 * GIB) {
  const root = mkdtempSync(join(SCRATCH, "store-"));
  return {
    partialDir: `${root}/partial`,
    stagedDir: `${root}/staged`,
    freeBytes: async () => free,
  };
}

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function slices(bytes: Uint8Array) {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += UPLOAD_CHUNK_BYTES)
    out.push(bytes.subarray(i, i + UPLOAD_CHUNK_BYTES));
  return out;
}

describe("chunked uploads", () => {
  test("reassembles chunks sent out of order into the staged file", async () => {
    const store = newStore();
    const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES * 2 + 1234);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
    const { id, chunks } = await createUpload(
      { name: "../clip.mov", size: bytes.length },
      store,
    );
    expect(chunks).toBe(3);
    const parts = slices(bytes);
    await Promise.all(
      [2, 0, 1].map((i) => writeChunk(id, i, parts[i]!, sha(parts[i]!), store)),
    );
    expect((await uploadStatus(id, store)).received).toEqual([0, 1, 2]);
    const result = await completeUpload(id, store);
    expect(result.name).toBe("../clip.mov");
    expect(result.path).toBe(`${store.stagedDir}/clip.mov`);
    expect(sha(readFileSync(result.path))).toBe(sha(bytes));
    // Completing again (a retried request) answers the same file.
    expect(await completeUpload(id, store)).toEqual(result);
  });

  test("reports missing chunks instead of finishing a hole-filled file", async () => {
    const store = newStore();
    const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES + 10);
    const { id } = await createUpload(
      { name: "a.mp4", size: bytes.length },
      store,
    );
    await writeChunk(id, 1, slices(bytes)[1]!, null, store);
    const error = await completeUpload(id, store).catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error.status).toBe(409);
    expect(error.missing).toEqual([0]);
  });

  test("rejects a corrupted or wrongly sized chunk", async () => {
    const store = newStore();
    const { id } = await createUpload({ name: "a.bin", size: 10 }, store);
    const chunk = new Uint8Array(10).fill(7);
    await expect(
      writeChunk(id, 0, chunk, "0".repeat(64), store),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      writeChunk(id, 0, chunk.subarray(0, 9), null, store),
    ).rejects.toMatchObject({ status: 400 });
    await expect(writeChunk(id, 1, chunk, null, store)).rejects.toMatchObject({
      status: 400,
    });
    expect((await uploadStatus(id, store)).received).toEqual([]);
  });

  test("refuses uploads that would fill the disk or exceed the cap", async () => {
    await expect(
      createUpload({ name: "big.mov", size: 4 * GIB }, newStore(6 * GIB)),
    ).rejects.toMatchObject({ status: 507 });
    await expect(
      createUpload({ name: "huge.mov", size: 10_000 * GIB }, newStore()),
    ).rejects.toMatchObject({ status: 413 });
    await expect(createUpload({ name: "x" }, newStore())).rejects.toMatchObject(
      { status: 400 },
    );
  });

  test("unknown or malformed ids are not found", async () => {
    const store = newStore();
    await expect(uploadStatus("../../etc", store)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      uploadStatus("00000000-0000-0000-0000-000000000000", store),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("cancel removes the partial upload", async () => {
    const store = newStore();
    const { id } = await createUpload({ name: "a.bin", size: 5 }, store);
    await cancelUpload(id, store);
    expect(readdirSync(store.partialDir)).toEqual([]);
  });

  test("a new upload prunes ones abandoned for a day", async () => {
    const store = newStore();
    const { id } = await createUpload({ name: "old.bin", size: 5 }, store);
    const meta = `${store.partialDir}/${id}/meta.json`;
    const parsed = JSON.parse(readFileSync(meta, "utf8"));
    writeFileSync(
      meta,
      JSON.stringify({ ...parsed, createdAt: Date.now() - 25 * 3600_000 }),
    );
    // A half-created directory with no metadata is judged by its own age.
    const orphan = `${store.partialDir}/11111111-1111-1111-1111-111111111111`;
    await mkdir(orphan);
    const old = new Date(Date.now() - 25 * 3600_000);
    await utimes(orphan, old, old);
    const fresh = await createUpload({ name: "new.bin", size: 5 }, store);
    expect(readdirSync(store.partialDir)).toEqual([fresh.id]);
  });
});
