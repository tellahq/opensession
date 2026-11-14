import { describe, expect, test } from "bun:test";
import { createDiffMountBudget } from "./diff-mount-budget";

function frames() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    request: (callback: () => void) => {
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    cancel: (id: number) => {
      pending.delete(id);
    },
    count: () => pending.size,
    flush() {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback();
    },
  };
}

describe("createDiffMountBudget", () => {
  test("grows one batch per frame until it covers the target", () => {
    const raf = frames();
    const budget = createDiffMountBudget(2, 4, raf.request, raf.cancel);
    const seen: number[] = [];
    budget.subscribe(() => seen.push(budget.read()));
    budget.grow(9);
    expect(budget.read()).toBe(2);
    raf.flush();
    expect(budget.read()).toBe(6);
    raf.flush();
    expect(budget.read()).toBe(10);
    expect(raf.count()).toBe(0);
    expect(seen).toEqual([6, 10]);
  });

  test("does nothing when the budget already covers the target", () => {
    const raf = frames();
    const budget = createDiffMountBudget(2, 4, raf.request, raf.cancel);
    budget.grow(2);
    expect(raf.count()).toBe(0);
  });

  test("cancel stops the pending frame", () => {
    const raf = frames();
    const budget = createDiffMountBudget(2, 4, raf.request, raf.cancel);
    const cancel = budget.grow(20);
    raf.flush();
    cancel();
    expect(raf.count()).toBe(0);
    expect(budget.read()).toBe(6);
  });

  test("unsubscribed listeners are not called", () => {
    const raf = frames();
    const budget = createDiffMountBudget(2, 4, raf.request, raf.cancel);
    let calls = 0;
    const unsubscribe = budget.subscribe(() => calls++);
    unsubscribe();
    budget.grow(6);
    raf.flush();
    expect(calls).toBe(0);
  });
});
