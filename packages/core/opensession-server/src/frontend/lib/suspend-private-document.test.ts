import { afterEach, expect, test } from "bun:test";
import { suspendPrivateDocument } from "./suspend-private-document";

// A bounded DOM fixture with explicit observer turns. Only the DOM operations
// used by suspension are implemented; no React/runtime/browser globals load.
class Root {
  readonly attributes = new Map<string, string>();
  parentElement: object | null = null;
  style = { display: "grid", visibility: "visible" };
  inert = false;
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}
const marker = "data-auth-suspended";
const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const originalObserver = Object.getOwnPropertyDescriptor(
  globalThis,
  "MutationObserver",
);
afterEach(() => {
  for (const [name, descriptor] of [
    ["document", originalDocument],
    ["MutationObserver", originalObserver],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
function fixture() {
  const body = { children: new Array<Root>() };
  const curtain = new Root();
  let notify = () => {};
  let disconnected = false;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body, createElement: () => curtain },
  });
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  });
  const append = (root: Root) => {
    root.parentElement = body;
    body.children.push(root);
  };
  const remove = (root: Root) => {
    body.children.splice(body.children.indexOf(root), 1);
    root.parentElement = null;
  };
  append(curtain);
  const stop = suspendPrivateDocument(document.createElement("div"));
  return {
    append,
    remove,
    curtain,
    stop,
    turn: () => {
      if (!disconnected) notify();
    },
    disconnected: () => disconnected,
  };
}

test("indefinite suspension releases detached roots across repeated observer turns", () => {
  const dom = fixture();
  for (let i = 0; i < 100; i++) {
    const root = new Root();
    dom.append(root);
    dom.turn();
    expect(root.getAttribute(marker)).toBe("");
    dom.remove(root);
    dom.turn();
    expect(root.getAttribute(marker)).toBeNull();
    // Reinsertion must be registered anew, proving removed entries were deleted.
    dom.append(root);
    dom.turn();
    expect(root.getAttribute(marker)).toBe("");
    dom.remove(root);
    dom.turn();
    expect(root.getAttribute(marker)).toBeNull();
  }
  expect(dom.curtain.getAttribute(marker)).toBeNull();
  dom.stop();
  expect(dom.disconnected()).toBe(true);
});

test("moved roots restore prior markers and reinsertion preserves subsequent app state", () => {
  const dom = fixture();
  const root = new Root();
  root.setAttribute(marker, "preexisting");
  dom.append(root);
  dom.turn();
  dom.remove(root);
  root.parentElement = { nested: true };
  dom.turn();
  expect(root.getAttribute(marker)).toBe("preexisting");
  root.setAttribute(marker, "new-owner");
  root.style.display = "flex";
  root.style.visibility = "hidden";
  root.inert = true;
  dom.append(root);
  dom.turn();
  expect(root.getAttribute(marker)).toBe("");
  dom.stop();
  expect(root.getAttribute(marker)).toBe("new-owner");
  expect(root.style).toEqual({ display: "flex", visibility: "hidden" });
  expect(root.inert).toBe(true);
});

test("final cleanup restores attached and newly detached roots and stops observation", () => {
  const dom = fixture();
  const attached = new Root();
  const detached = new Root();
  dom.append(attached);
  dom.append(detached);
  dom.turn();
  dom.remove(detached); // No observer turn before cleanup.
  dom.stop();
  expect(attached.getAttribute(marker)).toBeNull();
  expect(detached.getAttribute(marker)).toBeNull();
  const later = new Root();
  dom.append(later);
  dom.turn();
  expect(later.getAttribute(marker)).toBeNull();
});
