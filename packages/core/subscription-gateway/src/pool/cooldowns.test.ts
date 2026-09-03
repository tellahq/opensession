import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonCooldownRepository, MemoryCooldownRepository } from "../storage";
import { CooldownRegistry } from "./cooldowns";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CooldownRegistry", () => {
  test("separates model exhaustion from account-wide exhaustion", async () => {
    let now = 1_000;
    const registry = await CooldownRegistry.open(
      new MemoryCooldownRepository(),
      () => now,
    );
    await registry.markExhausted({
      accountId: "account-a",
      model: "model-a",
      until: 2_000,
    });
    expect(registry.isActive("account-a", "model-a")).toBe(true);
    expect(registry.isActive("account-a", "model-b")).toBe(false);

    await registry.markExhausted({ accountId: "account-a", until: 3_000 });
    expect(registry.isActive("account-a", "model-b")).toBe(true);
    now = 3_001;
    expect(registry.isActive("account-a", "model-a")).toBe(false);
  });

  test("does not let a wedge shorten exhaustion", async () => {
    const registry = await CooldownRegistry.open(
      new MemoryCooldownRepository(),
      () => 1_000,
    );
    await registry.markExhausted({ accountId: "account-a", until: 10_000 });
    expect(await registry.markWedged("account-a", 5_000)).toBeUndefined();
    expect(registry.isActive("account-a")).toBe(true);
  });

  test("clears only the wedge represented by its token", async () => {
    const registry = await CooldownRegistry.open(
      new MemoryCooldownRepository(),
      () => 1_000,
    );
    const token = await registry.markWedged("account-a", 5_000);
    expect(token).toBeDefined();
    if (!token) return;
    await registry.markExhausted({ accountId: "account-a", until: 4_000 });
    expect(await registry.clearWedge(token)).toBe(false);
    expect(registry.isActive("account-a")).toBe(true);
  });

  test("restores a shorter cooldown when a wedge is rolled back", async () => {
    const registry = await CooldownRegistry.open(
      new MemoryCooldownRepository(),
      () => 1_000,
    );
    await registry.markExhausted({ accountId: "account-a", until: 2_000 });
    const token = await registry.markWedged("account-a", 5_000);
    expect(token).toBeDefined();
    if (!token) return;
    expect(await registry.clearWedge(token)).toBe(true);
    expect(registry.activeRecords()).toEqual([
      {
        scope: "account",
        accountId: "account-a",
        reason: "exhausted",
        until: 2_000,
      },
    ]);
  });

  test("hydrates durable cooldowns after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subscription-gateway-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state", "cooldowns.json");
    const repository = new JsonCooldownRepository(path);
    const first = await CooldownRegistry.open(repository, () => 1_000);
    await first.markExhausted({
      accountId: "account-a",
      model: "model-a",
      until: 10_000,
    });

    const second = await CooldownRegistry.open(repository, () => 2_000);
    expect(second.isActive("account-a", "model-a")).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
      {
        scope: "model",
        accountId: "account-a",
        model: "model-a",
        reason: "exhausted",
        until: 10_000,
      },
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
