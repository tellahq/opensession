import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// UPLOADS_DIR is resolved at module load, so the scratch namespace has to be in
// place BEFORE uploads is imported. `bun test` shares one process across files,
// so the env is restored immediately afterwards.
const SCRATCH = mkdtempSync(join(tmpdir(), "uploads-"));
const saved = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = SCRATCH;
const {
  UPLOADS_DIR,
  countImageRefs,
  parseImageDataUrls,
  prepareCreationAttachmentSources,
  stageCreationAttachment,
  stageInlineImages,
} = await import("./uploads");
if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
else process.env.OPENSESSION_STATE_DIR = saved;

// A 1x1 PNG, small enough to keep the fixtures readable.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Write a file under the uploads dir and return the ref a composer would send. */
function stage(name: string, bytes: Buffer = PNG): string {
  const dir = `${UPLOADS_DIR}/staged`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}`;
  writeFileSync(path, bytes);
  return `/media?path=${encodeURIComponent(path)}`;
}

describe("actor-owned creation attachments", () => {
  test("spools inline input once and adopts one digest-fenced destination", () => {
    const raw = [
      {
        name: "brief.txt",
        dataUrl: `data:text/plain;base64,${Buffer.from("hello").toString("base64")}`,
      },
    ];
    const [source] = prepareCreationAttachmentSources("create-session", raw);
    expect(source.name).toBe("brief.txt");
    expect(source.sourceRef).toStartWith("uploads:");
    expect(source.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepareCreationAttachmentSources("create-session", raw)).toEqual([
      source,
    ]);
    const staged = stageCreationAttachment("create-session", source);
    expect(readFileSync(staged.path, "utf8")).toBe("hello");
    unlinkSync(
      `${UPLOADS_DIR}/${decodeURIComponent(source.sourceRef.slice("uploads:".length))}`,
    );
    expect(stageCreationAttachment("create-session", source)).toEqual(staged);
  });

  test("rejects malformed input instead of silently dropping an intent", () => {
    expect(() =>
      prepareCreationAttachmentSources("invalid-session", [
        { name: "missing-body.txt" },
      ]),
    ).toThrow("invalid file attachment");
  });

  test("rejects destination crossover instead of overwriting", () => {
    const [source] = prepareCreationAttachmentSources("cross-session", [
      {
        name: "brief.txt",
        dataUrl: `data:text/plain;base64,${Buffer.from("first").toString("base64")}`,
      },
    ]);
    const staged = stageCreationAttachment("cross-session", source);
    writeFileSync(staged.path, "changed");
    expect(() => stageCreationAttachment("cross-session", source)).toThrow(
      "destination changed",
    );
  });
});

describe("composer image references", () => {
  test("reads a staged ref back into vision bytes", () => {
    const images = parseImageDataUrls([stage("shot.png")]);
    expect(images).toEqual([
      { mediaType: "image/png", data: PNG.toString("base64") },
    ]);
  });

  test("infers the media type from the staged extension", () => {
    expect(parseImageDataUrls([stage("shot.JPG")])?.[0]?.mediaType).toBe(
      "image/jpeg",
    );
    expect(parseImageDataUrls([stage("shot.webp")])?.[0]?.mediaType).toBe(
      "image/webp",
    );
  });

  test("still takes inline data URLs, and mixes the two forms in order", () => {
    const inline = `data:image/gif;base64,${PNG.toString("base64")}`;
    const images = parseImageDataUrls([inline, stage("second.png")]);
    expect(images?.map((i) => i.mediaType)).toEqual(["image/gif", "image/png"]);
  });

  test("drops a ref outside the uploads dir", () => {
    const outside = `${SCRATCH}/escape.png`;
    writeFileSync(outside, PNG);
    expect(
      parseImageDataUrls([`/media?path=${encodeURIComponent(outside)}`]),
    ).toBeUndefined();
  });

  test("drops a ref whose file is gone, or whose type has no name", () => {
    expect(
      parseImageDataUrls([
        `/media?path=${encodeURIComponent(`${UPLOADS_DIR}/staged/missing.png`)}`,
      ]),
    ).toBeUndefined();
    expect(parseImageDataUrls([stage("notes.txt")])).toBeUndefined();
  });

  // The prompt route compares this against what actually resolved, so a stale
  // ref fails the send loudly instead of delivering a message without its
  // picture.
  test("counts what was meant to be an image, resolvable or not", () => {
    expect(
      countImageRefs([
        stage("counted.png"),
        `/media?path=${encodeURIComponent(`${UPLOADS_DIR}/staged/gone.png`)}`,
        `data:image/png;base64,${PNG.toString("base64")}`,
        "not an image",
        42,
      ]),
    ).toBe(3);
    expect(countImageRefs(undefined)).toBe(0);
  });
});

describe("staging images for a note", () => {
  test("references an already-staged image where it lies", () => {
    const ref = stage("note-shot.png");
    expect(stageInlineImages("os-note", [ref])).toEqual([ref]);
  });

  test("writes an inline image to disk and returns its media URL", () => {
    const [url] = stageInlineImages("os-note", [
      `data:image/png;base64,${PNG.toString("base64")}`,
    ]);
    expect(url).toStartWith("/media?path=");
    expect(parseImageDataUrls([url])?.[0]?.mediaType).toBe("image/png");
  });

  test("rejects a ref it cannot resolve", () => {
    expect(() =>
      stageInlineImages("os-note", ["/media?path=%2Fetc%2Fpasswd"]),
    ).toThrow("unsupported image type");
  });
});
