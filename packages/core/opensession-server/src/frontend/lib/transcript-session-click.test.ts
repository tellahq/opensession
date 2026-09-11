import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sessionIdFromTranscriptClick } from "./transcript-session-click";

const ID = "bks-a647de64-5a44-7f8d-b563-3ef568c1135e";

// The frontend tests run without a DOM. The helper only asks an element for
// `closest`, `dataset` and `getAttribute`, so a small stand-in for the two
// globals it type-checks against is enough. It is an EventTarget so it can
// be a click's target without a cast.
class FakeElement implements EventTarget {
  readonly dataset: Record<string, string | undefined>;
  constructor(
    private readonly attrs: Record<string, string>,
    private readonly parent: FakeElement | null = null,
  ) {
    const id = attrs["data-session-id"];
    this.dataset = id === undefined ? {} : { sessionId: id };
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  closest(selector: string): FakeElement | null {
    if (selector !== "[data-session-id]") throw new Error(selector);
    let node: FakeElement | null = this;
    while (node && !("data-session-id" in node.attrs)) node = node.parent;
    return node;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

const GLOBALS = ["Element", "HTMLElement"] as const;
const saved = GLOBALS.map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
beforeAll(() => {
  for (const key of GLOBALS)
    Object.defineProperty(globalThis, key, {
      value: FakeElement,
      configurable: true,
      writable: true,
    });
});
afterAll(() => {
  for (const { key, descriptor } of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function click(
  target: EventTarget | null,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>> = {},
) {
  return sessionIdFromTranscriptClick({
    target,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...mods,
  });
}

describe("sessionIdFromTranscriptClick", () => {
  test("a click inside a chip without an href opens the session", () => {
    const chip = new FakeElement({ role: "button", "data-session-id": ID });
    const inner = new FakeElement({}, chip);
    expect(click(inner)).toBe(ID);
  });

  test("a plain click on an href chip opens in place", () => {
    const chip = new FakeElement({
      href: `/session/${ID}`,
      "data-session-id": ID,
    });
    expect(click(chip)).toBe(ID);
  });

  test("a modified click on an href chip is left to the browser", () => {
    const chip = new FakeElement({
      href: `/session/${ID}`,
      "data-session-id": ID,
    });
    expect(click(chip, { metaKey: true })).toBeNull();
    expect(click(chip, { shiftKey: true })).toBeNull();
  });

  test("a modified click on a chip without an href still opens", () => {
    const chip = new FakeElement({ "data-session-id": ID });
    expect(click(chip, { ctrlKey: true })).toBe(ID);
  });

  test("anything else is left alone", () => {
    const p = new FakeElement({}, new FakeElement({}));
    expect(click(p)).toBeNull();
    expect(click(null)).toBeNull();
    expect(click(new EventTarget())).toBeNull();
  });
});
