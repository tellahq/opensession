import { afterEach, describe, expect, test } from "bun:test";
import { preparePromptImages, splitAttachments } from "./images";

// `bun test` has no DOM FileReader, and the inline fallback path needs one.
// Filled in only when absent, so a real one is never clobbered for other files
// sharing this process.
class TestFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(file: File) {
    void file.arrayBuffer().then((buf) => {
      this.result = `data:${file.type};base64,${Buffer.from(buf).toString("base64")}`;
      this.onload?.();
    });
  }
}
(globalThis as { FileReader?: unknown }).FileReader ??= TestFileReader;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function imageFile(name: string, type: string, bytes = 32): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** Stand in for POST /api/upload. Records what it was asked to stage. */
function uploadServer(staged: { name: string }[]) {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const name = decodeURIComponent(
      String((init.headers as Record<string, string>)["x-file-name"]),
    );
    staged.push({ name });
    return new Response(
      JSON.stringify({ ok: true, name, path: `/uploads/staged/${name}` }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("splitAttachments", () => {
  // The whole point of the change: a screenshot must not end up as base64 in
  // the composer's localStorage-backed outbox.
  test("stages an image and returns a media ref, not base64", async () => {
    const staged: { name: string }[] = [];
    uploadServer(staged);
    const { images, rejected } = await splitAttachments([
      imageFile("screenshot.png", "image/png"),
    ]);
    expect(images).toEqual([
      `/media?path=${encodeURIComponent("/uploads/staged/screenshot.png")}`,
    ]);
    expect(staged).toEqual([{ name: "screenshot.png" }]);
    expect(rejected).toEqual([]);
  });

  // A pasted screenshot arrives unnamed, and the staged path's extension is the
  // only record of its type.
  test("gives an unnamed paste a name carrying its type", async () => {
    const staged: { name: string }[] = [];
    uploadServer(staged);
    await splitAttachments([imageFile("", "image/jpeg")]);
    expect(staged[0]?.name).toMatch(/^pasted-\d+\.jpg$/);
  });

  test("rejects an unsupported image the browser cannot convert", async () => {
    uploadServer([]);
    const { images, rejected } = await splitAttachments([
      imageFile("diagram.svg", "image/svg+xml"),
    ]);
    expect(images).toEqual([]);
    expect(rejected).toEqual(["diagram.svg (use PNG, JPEG, GIF, or WebP)"]);
  });

  test("falls back to inline when staging fails for a small image", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const { images, rejected } = await splitAttachments([
      imageFile("small.png", "image/png"),
    ]);
    expect(images[0]).toStartWith("data:image/png;base64,");
    expect(rejected).toEqual([]);
  });

  // Above the inline ceiling there is nowhere to put the bytes, so say so at
  // attach time rather than failing the send later.
  test("reports a large image that could not be staged", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const { images, rejected } = await splitAttachments([
      imageFile("huge.png", "image/png", 1024 * 1024),
    ]);
    expect(images).toEqual([]);
    expect(rejected).toEqual(["huge.png (offline)"]);
  });

  test("still routes non-images to the file channel", async () => {
    const staged: { name: string }[] = [];
    uploadServer(staged);
    const { images, files } = await splitAttachments([
      imageFile("shot.png", "image/png"),
      imageFile("notes.txt", "text/plain"),
    ]);
    expect(images).toHaveLength(1);
    expect(files).toMatchObject([
      { name: "notes.txt", path: "/uploads/staged/notes.txt" },
    ]);
  });
});

describe("preparePromptImages", () => {
  test("keeps supported image data byte-for-byte identical", async () => {
    const png = "data:image/png;base64,aGVsbG8=";
    expect(await preparePromptImages([png])).toEqual([png]);
  });

  test("converts an older unsupported inline image before retrying it", async () => {
    const originalBitmap = globalThis.createImageBitmap;
    const originalDocument = globalThis.document;
    globalThis.createImageBitmap = (async () => ({
      width: 2,
      height: 1,
      close() {},
    })) as typeof createImageBitmap;
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toBlob: (callback: BlobCallback) =>
          callback(
            new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
          ),
      }),
    } as unknown as Document;
    try {
      const result = await preparePromptImages([
        "data:image/heic;base64,aGVsbG8=",
      ]);
      expect(result?.[0]).toStartWith("data:image/jpeg;base64,");
    } finally {
      globalThis.createImageBitmap = originalBitmap;
      globalThis.document = originalDocument;
    }
  });

  test("makes an unconvertible old image a terminal delivery error", async () => {
    await expect(
      preparePromptImages(["data:image/heic;base64,bm90LWFuLWltYWdl"]),
    ).rejects.toMatchObject({ status: 400 });
  });
});
