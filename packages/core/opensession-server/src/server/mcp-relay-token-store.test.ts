import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpRelayTokenStore } from "./mcp-relay-token-store";

let directory: string;
let legacyPath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-relay-tokens-"));
  legacyPath = join(directory, "relay.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function mintElsewhere(server: string, users: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { createMcpRelayTokenStore } from ${JSON.stringify(join(import.meta.dir, "mcp-relay-token-store.ts"))};
     console.log(await createMcpRelayTokenStore(${JSON.stringify(legacyPath)}).mint(${JSON.stringify(server)}, ${JSON.stringify(users)}));`,
    ],
    {
      env: {
        HOME: directory,
        OPENSESSION_STATE_DIR: directory,
        OPENSESSION_DEV: "1",
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
  const relay = createMcpRelayTokenStore(legacyPath);
  expect(await relay.lookup("x".repeat(32))).toBeUndefined();
  const token = await mintElsewhere("observability", ["Example"]);
  expect(await relay.lookup(token)).toMatchObject({
    server: grant.server,
    grantUsers: grant.grantUsers,
  });
  expect(await mintElsewhere("observability", ["Example"])).toBe(token);
  expect(
    await createMcpRelayTokenStore(legacyPath).lookup(token),
  ).toMatchObject({ server: grant.server, grantUsers: grant.grantUsers });
});

test("concurrent hosts reuse one token per identity without losing other grants", async () => {
  const requests = Array.from({ length: 12 }, (_, index) => ({
    server: `server-${index % 3}`,
    users: [`user-${index % 2}`],
  }));
  const tokens = await Promise.all(
    requests.map(({ server, users }) => mintElsewhere(server, users)),
  );
  const relay = createMcpRelayTokenStore(legacyPath);
  for (const [index, token] of tokens.entries()) {
    const request = requests[index]!;
    expect(await relay.lookup(token)).toMatchObject({
      server: request.server,
      grantUsers: request.users,
    });
    expect(await relay.mint(request.server, request.users)).toBe(token);
  }
  expect(new Set(tokens).size).toBe(6);
  const files = await readdir(`${legacyPath}.d`);
  expect(files.length).toBe(6);
  expect(files.every((name) => name.endsWith(".json"))).toBe(true);
  expect((await stat(`${legacyPath}.d`)).mode & 0o777).toBe(0o700);
  for (const file of files)
    expect((await stat(join(`${legacyPath}.d`, file))).mode & 0o777).toBe(
      0o600,
    );
}, 15_000);

test("server and ordered identities remain distinct", async () => {
  const store = createMcpRelayTokenStore(legacyPath);
  const tokens = await Promise.all([
    store.mint("a", ["creator", "prompter"]),
    store.mint("a", ["prompter", "creator"]),
    store.mint("b", ["creator", "prompter"]),
    store.mint("a", []),
    store.mint("a", ["creator\u0000prompter"]),
  ]);
  expect(new Set(tokens).size).toBe(5);
});

test("unknown, tampered and path-traversal tokens fail closed", async () => {
  const store = createMcpRelayTokenStore(legacyPath);
  const token = await store.mint("a", ["Example"]);
  for (const invalid of [
    "",
    "../relay.json",
    `v2.${"../".repeat(30)}`,
    `${token.slice(0, -1)}!`,
    `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
    `v2.${"0".repeat(64)}.${"x".repeat(32)}`,
  ]) {
    expect(await store.lookup(invalid)).toBeUndefined();
  }
});

test("legacy tokens remain readable, including updates from older detached hosts", async () => {
  const relay = createMcpRelayTokenStore(legacyPath);
  const first = "a".repeat(32);
  const second = "b".repeat(32);
  await writeFile(legacyPath, JSON.stringify({ [first]: grant }));
  expect(await relay.lookup(first)).toEqual(grant);
  expect(await relay.lookup(second)).toBeUndefined();
  const updated = JSON.stringify({ [second]: grant });
  await writeFile(legacyPath, updated);
  expect(await relay.lookup(second)).toEqual(grant);
  expect(await relay.lookup(first)).toBeUndefined();
  await relay.mint("other", []);
  expect(await readFile(legacyPath, "utf8")).toBe(updated);
});

test("invalid records do not grant access or get silently overwritten", async () => {
  const store = createMcpRelayTokenStore(legacyPath);
  await writeFile(
    legacyPath,
    JSON.stringify({ ["a".repeat(32)]: { server: "a" } }),
  );
  expect(await store.lookup("a".repeat(32))).toBeUndefined();
  const token = await store.mint("a", []);
  const [file] = await readdir(`${legacyPath}.d`);
  await writeFile(join(`${legacyPath}.d`, file!), "{}");
  expect(await store.lookup(token)).toBeUndefined();
  await expect(store.mint("a", [])).rejects.toThrow();
});
