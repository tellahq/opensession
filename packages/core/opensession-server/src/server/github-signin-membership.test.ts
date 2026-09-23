import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configuredIdentity, getConfigAsync } from "./config";
import { enrollGithubSignIn } from "./github-signin-membership";

const savedConfig = process.env.OPENSESSION_CONFIG;
const dirs: string[] = [];
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  await getConfigAsync();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(team: unknown[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "github-enrollment-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  const config = {
    integrations: {
      github: { userPrAuth: true, oauthClientId: "synthetic-client" },
    },
    identity: { team },
    extension: { preserve: true },
  };
  await writeFile(path, JSON.stringify(config));
  process.env.OPENSESSION_CONFIG = path;
  await getConfigAsync();
  return { path, config };
}

test("racing different accounts preserve every row and unknown config fields", async () => {
  const { path } = await fixture([
    { name: "Owner", github: "acme-owner", admin: true, custom: "keep" },
  ]);
  const names = Array.from({ length: 12 }, (_, i) => `acme-member-${i}`);
  await Promise.all(names.map(enrollGithubSignIn));
  const written = JSON.parse(await readFile(path, "utf8"));
  expect(written.identity.team).toHaveLength(13);
  expect(
    new Set(written.identity.team.map((m: { github: string }) => m.github))
      .size,
  ).toBe(13);
  expect(written.extension).toEqual({ preserve: true });
  expect(written.identity.team[0].custom).toBe("keep");
  expect(
    written.identity.team
      .slice(1)
      .every((m: { admin: boolean }) => m.admin === false),
  ).toBe(true);
  const backup = JSON.parse(await readFile(`${path}.bak-1`, "utf8"));
  expect(backup.identity.team).toHaveLength(1);
});

test("ambiguous and malformed known accounts are never repaired into a new membership", async () => {
  for (const team of [
    [
      { name: "First", github: "acme-member", admin: false },
      { name: "Second", github: "ACME-MEMBER", admin: true },
    ],
    [{ github: "acme-member", admin: true }],
  ]) {
    const { path, config } = await fixture(team);
    await expect(enrollGithubSignIn("acme-member")).rejects.toThrow(
      "Ambiguous or invalid",
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
  }
});

test("disabled sign-in, missing and malformed configuration fail closed", async () => {
  const { path, config } = await fixture();
  await writeFile(path, JSON.stringify({ ...config, integrations: {} }));
  await expect(enrollGithubSignIn("acme-member")).rejects.toThrow(
    "no longer enabled",
  );
  await writeFile(path, "{");
  await expect(enrollGithubSignIn("acme-member")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("{");
  await rm(path);
  await expect(enrollGithubSignIn("acme-member")).rejects.toThrow(
    "no longer enabled",
  );
  expect(configuredIdentity().team).toEqual([]);
});
