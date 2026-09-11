import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpRelayTokenReader } from "./mcp-relay-token-store";

let directory: string;
let legacyPath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-relay-tokens-"));
  legacyPath = join(directory, ".opensession-mcp-relay.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function mintElsewhere(server: string, users: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { mintMcpRelayToken } from ${JSON.stringify(join(import.meta.dir, "mcp-relay.ts"))};
       console.log(await mintMcpRelayToken(${JSON.stringify(server)}, ${JSON.stringify(users)}));`,
    ],
    {
      env: {
        HOME: directory,
        OPENSESSION_STATE_DIR: directory,
        OPENSESSION_DEV: "1",
        OPENSESSION_MCP_CONFIG: join(directory, "mcp-config.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return stdout.trim();
}

const grant = {
  server: "observability",
  grantUsers: ["Example"],
  createdAt: "2026-09-11T00:00:00Z",
};

test("a running relay sees tokens minted later in another process", async () => {
  const relay = createMcpRelayTokenReader(legacyPath);
  expect(await relay.lookup("x".repeat(32))).toBeUndefined();
  const token = await mintElsewhere("observability", ["Example"]);
  expect(await relay.lookup(token)).toMatchObject({
    server: grant.server,
    grantUsers: grant.grantUsers,
  });
  expect(await mintElsewhere("observability", ["Example"])).toBe(token);
  expect(
    await createMcpRelayTokenReader(legacyPath).lookup(token),
  ).toMatchObject({
    server: grant.server,
    grantUsers: grant.grantUsers,
  });
});

test("newly issued tokens remain usable by the legacy gateway after rollback", async () => {
  const first = await mintElsewhere("observability", ["Example"]);
  const second = await mintElsewhere("other", ["Creator", "Prompter"]);
  // A freshly started old gateway resolves a token by indexing this JSON map.
  // New formats must not be issued until that rollback target supports them.
  expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(second).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(JSON.parse(await readFile(legacyPath, "utf8"))).toMatchObject({
    [first]: { server: "observability", grantUsers: ["Example"] },
    [second]: { server: "other", grantUsers: ["Creator", "Prompter"] },
  });
  expect(await readdir(directory)).not.toContain(
    ".opensession-mcp-relay.json.d",
  );
});

test("the compatibility reader accepts v2 records without issuing them", async () => {
  const reader = createMcpRelayTokenReader(legacyPath);
  const key = "1".repeat(64);
  const token = `v2.${key}.${"a".repeat(32)}`;
  expect(await reader.lookup(token)).toBeUndefined();
  await mkdir(`${legacyPath}.d`);
  const recordPath = join(`${legacyPath}.d`, `${key}.json`);
  await writeFile(recordPath, JSON.stringify({ ...grant, token }));
  expect(await reader.lookup(token)).toMatchObject(grant);
  expect(await reader.lookup(`${token.slice(0, -1)}b`)).toBeUndefined();
  await writeFile(recordPath, "{}");
  expect(await reader.lookup(token)).toBeUndefined();
});

test("unknown, malformed and path-traversal tokens fail closed", async () => {
  const reader = createMcpRelayTokenReader(legacyPath);
  for (const invalid of [
    "",
    "../relay.json",
    `v2.${"../".repeat(30)}`,
    "x".repeat(32),
    `v2.${"0".repeat(64)}.${"x".repeat(32)}`,
  ]) {
    expect(await reader.lookup(invalid)).toBeUndefined();
  }
  await writeFile(
    legacyPath,
    JSON.stringify({ ["a".repeat(32)]: { server: "a" } }),
  );
  expect(await reader.lookup("a".repeat(32))).toBeUndefined();
});

test("legacy token updates are read fresh without rewriting the map", async () => {
  const relay = createMcpRelayTokenReader(legacyPath);
  const first = "a".repeat(32);
  const second = "b".repeat(32);
  await writeFile(legacyPath, JSON.stringify({ [first]: grant }));
  expect(await relay.lookup(first)).toEqual(grant);
  expect(await relay.lookup(second)).toBeUndefined();
  const updated = JSON.stringify({ [second]: grant });
  await writeFile(legacyPath, updated);
  expect(await relay.lookup(second)).toEqual(grant);
  expect(await relay.lookup(first)).toBeUndefined();
  expect(await readFile(legacyPath, "utf8")).toBe(updated);
});
