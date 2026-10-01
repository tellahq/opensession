import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeJsonAtomic } from "./atomic-write";
import { readJsonFileCopy, readJsonFileShared } from "./json-file-cache";

const dir = mkdtempSync(join(tmpdir(), "json-file-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("json file cache", () => {
  test("an unchanged file returns the same parse without re-reading", () => {
    const path = join(dir, "same.json");
    writeJsonAtomic(path, { a: 1 });
    const first = readJsonFileShared<{ a: number }>(path);
    expect(first).toEqual({ a: 1 });
    expect(readJsonFileShared<{ a: number }>(path)).toBe(first);
  });

  test("an atomic replace is seen on the next read", () => {
    const path = join(dir, "replace.json");
    writeJsonAtomic(path, { v: 1 });
    expect(readJsonFileShared<{ v: number }>(path)?.v).toBe(1);
    writeJsonAtomic(path, { v: 2 });
    expect(readJsonFileShared<{ v: number }>(path)?.v).toBe(2);
  });

  test("an in-place rewrite of a different size is seen", () => {
    const path = join(dir, "inplace.json");
    writeFileSync(path, JSON.stringify({ v: 1 }));
    expect(readJsonFileShared<{ v: number }>(path)?.v).toBe(1);
    writeFileSync(path, JSON.stringify({ v: 22 }));
    expect(readJsonFileShared<{ v: number }>(path)?.v).toBe(22);
  });

  test("a missing file is undefined and invalid JSON throws", () => {
    expect(readJsonFileShared(join(dir, "missing.json"))).toBeUndefined();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{nope");
    expect(() => readJsonFileShared(bad)).toThrow();
  });

  test("copies are private to the caller", () => {
    const path = join(dir, "copy.json");
    writeJsonAtomic(path, { list: [1] });
    const copy = readJsonFileCopy<{ list: number[] }>(path)!;
    copy.list.push(2);
    expect(readJsonFileShared<{ list: number[] }>(path)?.list).toEqual([1]);
  });
});
