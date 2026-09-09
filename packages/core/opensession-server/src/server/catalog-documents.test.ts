import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogDocuments,
  importApplicationCatalog,
} from "./catalog-documents";
import { __setSessionKernelStoreForTest } from "./session-kernel/kernel";
import { catalogUserStore } from "./shared/catalog-user-store";
import { canonicalName } from "./shared/user-store-key";
import { SessionKernelStore } from "./session-kernel/store";

let root: string;
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let previousRoot: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "application-catalog-"));
  previousRoot = process.env.OPENSESSION_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = root;
  store = new SessionKernelStore(join(root, "kernel.sqlite"));
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(async () => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  await rm(root, { recursive: true, force: true });
});
async function legacy(namespace: string, key: string, value: unknown) {
  const directory = join(root, `.opensession-${namespace}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${key}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("application catalog ownership", () => {
  test("imports once; reads never consult or resurrect the legacy files", async () => {
    const file = await legacy("workspaces", "ws-first", {
      id: "ws-first",
      name: "First",
    });
    await importApplicationCatalog();
    const documents = catalogDocuments("workspaces");
    expect(await documents.get("ws-first")).toEqual({
      id: "ws-first",
      name: "First",
    });
    await writeFile(file, "broken legacy export");
    expect(await documents.get("ws-first")).toEqual({
      id: "ws-first",
      name: "First",
    });
    await importApplicationCatalog();
    expect(await documents.delete("ws-first")).toBe(true);
    await legacy("workspaces", "ws-first", { name: "Old file returned" });
    await importApplicationCatalog();
    expect(await documents.get("ws-first")).toBeNull();
    expect(await documents.list()).toEqual([]);
  });

  test("an interrupted import never overwrites newer catalog state", async () => {
    const documents = catalogDocuments("workspaces");
    await documents.set("ws-first", { name: "Committed" });
    await legacy("workspaces", "ws-first", { name: "Stale" });
    await importApplicationCatalog();
    expect(await documents.get("ws-first")).toEqual({ name: "Committed" });
  });

  test("invalid legacy JSON fails migration instead of silently dropping a document", async () => {
    const path = await legacy("automations", "auto-first", {});
    await writeFile(path, "{ invalid");
    await expect(importApplicationCatalog()).rejects.toThrow();
    await writeFile(path, JSON.stringify({ name: "Recovered" }));
    await importApplicationCatalog();
    expect(await catalogDocuments("automations").get("auto-first")).toEqual({
      name: "Recovered",
    });
  });

  test("concurrent updates keep every mutation and export the committed result", async () => {
    const documents = catalogDocuments("pins");
    await documents.set("person", []);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        documents.update("person", (value) => {
          if (!Array.isArray(value)) throw new Error("Expected a list");
          return [...value, index];
        }),
      ),
    );
    expect(await documents.get("person")).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
    expect(
      JSON.parse(
        await readFile(join(root, ".opensession-pins/person.json"), "utf8"),
      ),
    ).toEqual(await documents.get("person"));
  });

  test("catalog state and tombstones survive closing and reopening the kernel", async () => {
    const documents = catalogDocuments("workspaces");
    await documents.set("ws-kept", { name: "Kept" });
    await documents.set("ws-deleted", { name: "Deleted" });
    await documents.delete("ws-deleted");
    store.close();
    store = new SessionKernelStore(join(root, "kernel.sqlite"));
    __setSessionKernelStoreForTest(store);
    expect(await documents.get("ws-kept")).toEqual({ name: "Kept" });
    expect(await documents.get("ws-deleted")).toBeNull();
    expect(
      await documents.getMany(["ws-deleted", "ws-kept", "missing"]),
    ).toEqual([{ key: "ws-kept", value: { name: "Kept" } }]);
  });

  test("export failure never fails a committed mutation or switches reads back to a file", async () => {
    await writeFile(join(root, ".opensession-pins"), "not a directory");
    const documents = catalogDocuments("pins");
    await documents.set("person", { pins: ["committed"] });
    expect(await documents.get("person")).toEqual({ pins: ["committed"] });
    await rm(join(root, ".opensession-pins"));
    await documents.set("person", { pins: ["retried"] });
    expect(await documents.get("person")).toEqual({ pins: ["retried"] });
  });

  test("an unchanged mutation does not rewrite the catalog or legacy export", async () => {
    const documents = catalogDocuments("pins");
    await documents.set("person", { pins: [] });
    const before = store.catalogDocumentGet("pins", "person");
    await documents.update("person", (value) => value);
    expect(store.catalogDocumentGet("pins", "person")).toEqual(before);
  });

  test("a canonical tombstone masks imported legacy user spellings", async () => {
    const documents = catalogDocuments("pins");
    await documents.set("Ada", { pins: ["legacy"] });
    await documents.delete(canonicalName("Ada"));
    const preferences = catalogUserStore({
      name: "pins",
      field: "pins",
      clean: (value) => (Array.isArray(value) ? value : []),
    });
    expect(await preferences.get("Ada")).toEqual([]);
    await preferences.update("Ada", (pins) => [...pins, "new"]);
    expect(await preferences.get("Ada")).toEqual(["new"]);
  });

  test("namespace and filename keys cannot escape the selected state root", async () => {
    expect(() => catalogDocuments("../../elsewhere")).toThrow();
    await expect(
      catalogDocuments("pins").set("../elsewhere", {}),
    ).rejects.toThrow();
    await expect(
      catalogDocuments("pins").set("person", undefined),
    ).rejects.toThrow();
  });
});
