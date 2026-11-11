import { describe, expect, test } from "bun:test";
import { createCopiedPathStore } from "./copied-path-store";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createCopiedPathStore", () => {
  test("shows a copied path, then clears it", async () => {
    const store = createCopiedPathStore(20);
    let notified = 0;
    store.subscribe(() => notified++);
    store.show("src/a.ts");
    expect(store.get()).toBe("src/a.ts");
    await wait(40);
    expect(store.get()).toBeNull();
    expect(notified).toBe(2);
  });

  test("copying another path moves the check and restarts the timer", async () => {
    const store = createCopiedPathStore(30);
    store.show("src/a.ts");
    await wait(15);
    store.show("src/b.ts");
    expect(store.get()).toBe("src/b.ts");
    await wait(20);
    expect(store.get()).toBe("src/b.ts");
    await wait(30);
    expect(store.get()).toBeNull();
  });

  test("dispose cancels the pending reset", async () => {
    const store = createCopiedPathStore(10);
    let notified = 0;
    store.subscribe(() => notified++);
    store.show("src/a.ts");
    store.dispose();
    await wait(25);
    expect(notified).toBe(1);
  });
});
