import { expect, test } from "bun:test";
import { createPinnedDragStore } from "./pinned-drag-store";

test("the Pinned drag store notifies only when the draft or dragged entry changes", () => {
  const store = createPinnedDragStore();
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);

  store.set({ dragKey: null });
  expect(calls).toBe(0);

  store.set({ dragKey: "ws:a" });
  const draft = ["ws:b", "ws:a"];
  store.set({ draft });
  store.set({ draft });
  expect(calls).toBe(2);
  expect(store.get()).toEqual({ draft, dragKey: "ws:a" });

  unsubscribe();
  store.set({ draft: null, dragKey: null });
  expect(calls).toBe(2);
  expect(store.get()).toEqual({ draft: null, dragKey: null });
});
