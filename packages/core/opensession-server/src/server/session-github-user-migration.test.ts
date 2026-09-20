import { getConfigAsync } from "./config";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const config = process.env.OPENSESSION_CONFIG;
const operator = process.env.OPENSESSION_OPERATOR_MIGRATION;
process.env.OPENSESSION_CONFIG = join(
  process.env.HOME!,
  "migration-config.json",
);
await getConfigAsync();
await writeFile(
  process.env.OPENSESSION_CONFIG,
  JSON.stringify({
    identity: {
      team: [{ name: "Ada", email: "ada@example.test", github: "ada-login" }],
    },
  }),
);
await getConfigAsync();
const { SessionKernelStore, __setSessionKernelStoreForTest, sessionMetadata } =
  await import("./session-kernel");
const { SessionListStore, __setSessionListStoreForTest } =
  await import("./session-list-store");
const { migrateSessionGithubUsers } =
  await import("./session-github-user-migration");
const kernel = new SessionKernelStore(":memory:");
const prior = __setSessionKernelStoreForTest(kernel);
const index = new SessionListStore(":memory:");
const priorIndex = __setSessionListStoreForTest(index);

beforeAll(async () => {
  for (const [id, fields] of Object.entries({
    "os-a": {},
    "os-b": {},
    "os-c": { createdByLogin: "kept" },
    "os-d": { automationId: "job" },
    "os-e": { createdBy: "Unknown" },
  })) {
    const data = {
      id,
      title: "Task",
      createdBy: "Ada",
      createdAt: "2026-09-17T00:00:00Z",
      repoLess: true,
      ...fields,
    };
    await sessionMetadata({
      op: "put",
      sessionId: id,
      requestId: id,
      expectedRev: null,
      rev: 1,
      doc: JSON.stringify(data),
      archived: false,
      lastActivityMs: 0,
    });
  }
  await sessionMetadata({ op: "mark_catalog_complete" });
});
afterAll(async () => {
  __setSessionKernelStoreForTest(prior);
  kernel.close();
  __setSessionListStoreForTest(priorIndex);
  index.close();
  if (config === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = config;
    await getConfigAsync();
  }
  if (operator === undefined) delete process.env.OPENSESSION_OPERATOR_MIGRATION;
  else process.env.OPENSESSION_OPERATOR_MIGRATION = operator;
});

test("identity backfill is explicit, dry by default, bounded and resumable", async () => {
  delete process.env.OPENSESSION_OPERATOR_MIGRATION;
  const forbidden = await migrateSessionGithubUsers().then(
    () => null,
    (error) => error,
  );
  expect(forbidden.message).toContain("explicit operator");
  process.env.OPENSESSION_OPERATOR_MIGRATION = "1";
  const preview = await migrateSessionGithubUsers({ limit: 1 });
  expect(preview).toMatchObject({
    dryRun: true,
    updated: 0,
    after: "os-a",
    complete: false,
    candidates: [{ sessionId: "os-a", login: "ada-login" }],
  });
  expect(
    (await sessionMetadata({ op: "catalog_get", sessionId: "os-a" }))?.rev,
  ).toBe(1);
  expect(
    (await migrateSessionGithubUsers({ apply: true, limit: 1 })).updated,
  ).toBe(1);
  const rest = await migrateSessionGithubUsers({
    apply: true,
    after: preview.after,
  });
  expect(rest).toMatchObject({
    updated: 1,
    complete: true,
    candidates: [{ sessionId: "os-b", login: "ada-login" }],
  });
  for (const [id, login] of [
    ["os-a", "ada-login"],
    ["os-b", "ada-login"],
    ["os-c", "kept"],
  ])
    expect(
      JSON.parse(
        (await sessionMetadata({ op: "catalog_get", sessionId: id! }))!.doc,
      ).createdByLogin,
    ).toBe(login);
  for (const id of ["os-d", "os-e"])
    expect(
      JSON.parse(
        (await sessionMetadata({ op: "catalog_get", sessionId: id }))!.doc,
      ).createdByLogin,
    ).toBeUndefined();
  expect((await migrateSessionGithubUsers({ apply: true })).updated).toBe(0);
  const invalid = await migrateSessionGithubUsers({
    apply: true,
    limit: 101,
  }).then(
    () => null,
    (error) => error,
  );
  expect(invalid.message).toContain("1..100");
});
