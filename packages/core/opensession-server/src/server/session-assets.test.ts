import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  ASSETS_ROOT,
  deleteAssetAcross,
  listAssetsAcross,
  readAssetAcross,
  S3AssetStore,
  writeAsset,
} from "./session-assets";
import { sessionIdsFor } from "./session-cache";
import type { UnifiedSession } from "./types";

const canonicalId = `test-assets-canonical-${process.pid}`;
const aliasId = `test-assets-alias-${process.pid}`;
const originalConfig = process.env.OPENSESSION_CONFIG;
const testConfig = join(
  process.env.OPENSESSION_SCRATCH || "/tmp",
  `missing-assets-config-${process.pid}.json`,
);

beforeEach(() => {
  process.env.OPENSESSION_CONFIG = testConfig;
});

afterEach(() => {
  if (originalConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = originalConfig;
  rmSync(`${ASSETS_ROOT}/${canonicalId}`, { recursive: true, force: true });
  rmSync(`${ASSETS_ROOT}/${aliasId}`, { recursive: true, force: true });
});

describe("session asset aliases", () => {
  test("returns the canonical id before historical aliases", () => {
    const session = {
      id: canonicalId,
      aliasIds: [aliasId],
    } as UnifiedSession;

    expect(sessionIdsFor(canonicalId, [session])).toEqual([
      canonicalId,
      aliasId,
    ]);
    expect(sessionIdsFor(aliasId, [session])).toEqual([canonicalId, aliasId]);
  });

  test("lists, reads, and deletes files stored under an alias", async () => {
    await writeAsset(
      aliasId,
      "legacy.csv",
      Buffer.from("name\nAda\n"),
      "Legacy customer export",
    );
    await writeAsset(canonicalId, "duplicate.txt", Buffer.from("canonical"));
    await writeAsset(aliasId, "duplicate.txt", Buffer.from("legacy"));

    expect(await listAssetsAcross([canonicalId, aliasId])).toMatchObject([
      { path: "duplicate.txt", size: 9 },
      {
        path: "legacy.csv",
        size: 9,
        description: "Legacy customer export",
      },
    ]);
    expect(
      (await readAssetAcross([canonicalId, aliasId], "legacy.csv"))?.sessionId,
    ).toBe(aliasId);

    await deleteAssetAcross([canonicalId, aliasId], "duplicate.txt");
    expect(await listAssetsAcross([canonicalId, aliasId])).toMatchObject([
      { path: "legacy.csv" },
    ]);
  });

  test("preserves descriptions across rewrites and removes them with files", async () => {
    await writeAsset(
      canonicalId,
      "report.html",
      Buffer.from("first"),
      "Q3 report",
    );
    await writeAsset(canonicalId, "report.html", Buffer.from("second"));

    expect(await listAssetsAcross([canonicalId])).toMatchObject([
      { path: "report.html", description: "Q3 report" },
    ]);

    await deleteAssetAcross([canonicalId], "./report.html");
    await writeAsset(canonicalId, "report.html", Buffer.from("third"));
    expect(
      (await listAssetsAcross([canonicalId]))[0]?.description,
    ).toBeUndefined();
  });

  test("reserves the description metadata filename", async () => {
    await expect(
      writeAsset(canonicalId, ".opensession-assets.json", Buffer.from("{}")),
    ).rejects.toThrow("reserved for asset metadata");
  });

  test("stores descriptions for filenames that overlap object properties", async () => {
    await writeAsset(
      canonicalId,
      "__proto__",
      Buffer.from("data"),
      "Prototype report",
    );
    expect(await listAssetsAcross([canonicalId])).toMatchObject([
      { path: "__proto__", description: "Prototype report" },
    ]);
  });
});

type FakeObject = {
  body: Buffer;
  metadata?: Record<string, string>;
  contentType?: string;
  lastModified: Date;
};

class FakeS3 {
  objects = new Map<string, FakeObject>();

  async send(command: any): Promise<any> {
    const input = command.input;
    if (command instanceof PutObjectCommand) {
      this.objects.set(input.Key, {
        body: Buffer.from(input.Body),
        metadata: input.Metadata,
        contentType: input.ContentType,
        lastModified: new Date("2026-08-20T12:00:00.000Z"),
      });
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object)
        throw Object.assign(new Error("missing"), { name: "NotFound" });
      return {
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
        LastModified: object.lastModified,
        Metadata: object.metadata,
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object)
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return {
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
        LastModified: object.lastModified,
        Metadata: object.metadata,
        Body: {
          transformToByteArray: async () => new Uint8Array(object.body),
          transformToWebStream: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(object.body));
                controller.close();
              },
            }),
        },
      };
    }
    if (command instanceof ListObjectsV2Command) {
      const keys = [...this.objects.keys()]
        .filter((key) => key.startsWith(input.Prefix || ""))
        .sort();
      return {
        Contents: keys.map((key) => {
          const object = this.objects.get(key)!;
          return {
            Key: key,
            Size: object.body.byteLength,
            LastModified: object.lastModified,
          };
        }),
        IsTruncated: false,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of input.Delete.Objects)
        this.objects.delete(object.Key);
      return {};
    }
    throw new Error(`Unexpected command: ${command.constructor.name}`);
  }
}

describe("S3-compatible asset storage", () => {
  const config = {
    provider: "s3" as const,
    bucket: "assets",
    region: "auto",
    endpoint: "https://account.r2.cloudflarestorage.com",
    prefix: "opensession-assets",
    accessKeyId: "key",
    secretAccessKey: "secret",
    forcePathStyle: false,
  };

  test("stores descriptions in object metadata and preserves them on rewrite", async () => {
    const client = new FakeS3();
    const store = new S3AssetStore(config, client);
    await store.write(
      canonicalId,
      "reports/café.txt",
      Buffer.from("first"),
      "Café ✓",
    );

    const object = client.objects.get(
      `opensession-assets/${canonicalId}/reports/café.txt`,
    );
    expect(object?.metadata?.["opensession-description"]).toBe(
      encodeURIComponent("Café ✓"),
    );

    await store.write(canonicalId, "reports/café.txt", Buffer.from("second"));
    expect(await store.list(canonicalId)).toMatchObject([
      {
        path: "reports/café.txt",
        description: "Café ✓",
        size: 6,
      },
    ]);
    expect(
      (await store.read(canonicalId, "reports/café.txt"))?.data.toString(),
    ).toBe("second");
    const opened = await store.open(canonicalId, "reports/café.txt");
    expect(await new Response(opened!.body).text()).toBe("second");
  });

  test("deletes an object or a whole virtual folder without prefix collisions", async () => {
    const client = new FakeS3();
    const store = new S3AssetStore(config, client);
    await store.write(canonicalId, "shots/a.png", Buffer.from("a"));
    await store.write(canonicalId, "shots/nested/b.png", Buffer.from("b"));
    await store.write(canonicalId, "shots-extra/c.png", Buffer.from("c"));

    expect(await store.delete(canonicalId, "shots")).toBe(true);
    expect((await store.list(canonicalId)).map((file) => file.path)).toEqual([
      "shots-extra/c.png",
    ]);
  });
});
