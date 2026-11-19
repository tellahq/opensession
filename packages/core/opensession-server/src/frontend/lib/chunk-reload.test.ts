import { describe, expect, test } from "bun:test";
import { importOrReload, isChunkLoadError } from "./chunk-reload";

function env(start = 1_000_000) {
  const store = new Map<string, string>();
  const state = { now: start, reloads: 0 };
  return {
    state,
    env: {
      storage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
      now: () => state.now,
      reload: () => void state.reloads++,
    },
  };
}

const missing = () =>
  Promise.reject(
    new TypeError(
      "Failed to fetch dynamically imported module: https://acme.example.test/Settings-abc.js",
    ),
  );

describe("chunk reload", () => {
  test("recognizes each browser's missing-chunk error", () => {
    expect(
      isChunkLoadError(
        new TypeError("Failed to fetch dynamically imported module: /x.js"),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError(
        new TypeError("error loading dynamically imported module: /x.js"),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError("Importing a module script failed.")),
    ).toBe(true);
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
  });

  test("a missing chunk reloads and leaves the import pending", async () => {
    const { state, env: e } = env();
    let settled = false;
    void importOrReload(missing, e).then(
      () => (settled = true),
      () => (settled = true),
    );
    await Bun.sleep(0);
    expect(state.reloads).toBe(1);
    expect(settled).toBe(false);
  });

  test("a second miss right after a reload rethrows instead of looping", async () => {
    const { state, env: e } = env();
    void importOrReload(missing, e);
    await Bun.sleep(0);
    state.now += 5_000;
    await expect(importOrReload(missing, e)).rejects.toThrow(
      "dynamically imported module",
    );
    expect(state.reloads).toBe(1);
    state.now += 60_000;
    void importOrReload(missing, e);
    await Bun.sleep(0);
    expect(state.reloads).toBe(2);
  });

  test("other errors and successes pass through", async () => {
    const { state, env: e } = env();
    await expect(
      importOrReload(() => Promise.reject(new Error("boom")), e),
    ).rejects.toThrow("boom");
    expect(await importOrReload(() => Promise.resolve(42), e)).toBe(42);
    expect(state.reloads).toBe(0);
  });
});
