import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as disk from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configuredIdentity,
  configuredRepos,
  configPath,
  getConfig,
  getConfigAsync,
  githubBotLogins,
  personaName,
  productMark,
  productName,
} from "./config";
import { persistRawConfig } from "./config-mutation";

const previous = process.env.OPENSESSION_CONFIG;
const roots: string[] = [];
async function fixture(contents?: string): Promise<string> {
  const root = await disk.mkdtemp(join(tmpdir(), "config-snapshot-"));
  roots.push(root);
  const path = join(root, "config.json");
  if (contents !== undefined) await disk.writeFile(path, contents);
  process.env.OPENSESSION_CONFIG = path;
  await getConfigAsync();
  return path;
}

afterEach(async () => {
  if (previous === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previous;
  await getConfigAsync();
  for (const root of roots.splice(0)) await disk.rm(root, { recursive: true });
});

for (const missing of [false, true]) {
  test(`100,000 hot reads never use synchronous filesystem I/O (${missing ? "missing" : "present"} config)`, async () => {
    await fixture(
      missing ? undefined : JSON.stringify({ persona: { name: "Ada" } }),
    );
    const stat = spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("Hot config reads must not stat synchronously");
    });
    const read = spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("Hot config reads must not read synchronously");
    });
    try {
      const snapshot = getConfig();
      for (let i = 0; i < 100_000; i++) {
        getConfig();
        personaName();
        productMark();
        productName();
        configuredIdentity();
        configuredRepos();
        githubBotLogins();
      }
      expect(getConfig()).toBe(snapshot);
      expect(personaName()).toBe(missing ? "Assistant" : "Ada");
      expect(stat).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      stat.mockRestore();
      read.mockRestore();
    }
  });
}

test("a new namespace cannot read the previous namespace's identity", async () => {
  const first = await fixture('{"persona":{"name":"first"}}');
  process.env.OPENSESSION_CONFIG = join(roots.at(-1)!, "other.json");
  expect(() => getConfig()).toThrow("await getConfigAsync()");
  await getConfigAsync();
  expect(getConfig()).toEqual({});
  process.env.OPENSESSION_CONFIG = first;
  expect(personaName()).toBe("first");
});

test("async refresh observes replacement with the same mtime/size, deletion and invalid JSON", async () => {
  const path = await fixture('{"persona":{"name":"first"}}');
  const before = await disk.stat(path);
  const replacement = `${path}.next`;
  await disk.writeFile(replacement, '{"persona":{"name":"other"}}');
  await disk.utimes(replacement, before.atime, before.mtime);
  await disk.rename(replacement, path);
  await getConfigAsync();
  expect(personaName()).toBe("other");
  await disk.writeFile(path, "{invalid");
  expect(await getConfigAsync()).toEqual({});
  expect(getConfig()).toEqual({});
  await disk.rm(path);
  expect(await getConfigAsync()).toEqual({});
  await disk.writeFile(path, '{"persona":{"name":"again"}}');
  await getConfigAsync();
  expect(personaName()).toBe("again");
});

test("slow background refresh is single-flight and leaves HTTP/timers responsive", async () => {
  const path = await fixture('{"persona":{"name":"before"}}');
  await disk.writeFile(path, '{"persona":{"name":"after"}}');
  const gate = Promise.withResolvers<void>();
  const originalStat = disk.stat;
  const stat = spyOn(disk, "stat").mockImplementation((async (
    ...args: Parameters<typeof disk.stat>
  ) => {
    await gate.promise;
    return originalStat(...args);
  }) as typeof disk.stat);
  const clock = spyOn(performance, "now").mockReturnValue(
    performance.now() + 2_000,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(personaName()),
  });
  try {
    // Trigger a stale-while-refresh read, then hammer both interfaces while
    // disk is deliberately held. Neither more I/O nor a blocking wait occurs.
    for (let i = 0; i < 100_000; i++) getConfig();
    const pending = Array.from({ length: 100 }, () => getConfigAsync());
    expect(stat).toHaveBeenCalledTimes(1);
    expect(await (await fetch(server.url)).text()).toBe("before");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    gate.resolve();
    await Promise.all(pending);
    expect(personaName()).toBe("after");
    expect(stat).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve();
    await getConfigAsync();
    stat.mockRestore();
    clock.mockRestore();
    server.stop(true);
  }
});

test("a successful settings write publishes immediately and fences an older in-flight read", async () => {
  const path = await fixture('{"persona":{"name":"initial"}}');
  await disk.writeFile(path, '{"persona":{"name":"old external edit"}}');
  const gate = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  const originalRead = disk.readFile;
  const read = spyOn(disk, "readFile").mockImplementation((async (
    ...args: Parameters<typeof disk.readFile>
  ) => {
    const contents = await originalRead(...args);
    captured.resolve();
    await gate.promise;
    return contents;
  }) as typeof disk.readFile);
  const pending = getConfigAsync();
  try {
    await captured.promise;
    persistRawConfig({ persona: { name: "committed settings" } });
    expect(personaName()).toBe("committed settings");
    gate.resolve();
    expect((await pending).persona?.name).toBe("committed settings");
    expect(personaName()).toBe("committed settings");
  } finally {
    gate.resolve();
    await pending;
    read.mockRestore();
  }
  expect(configPath()).toBe(path);
});
