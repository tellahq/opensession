import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { holdTranscriptAnchor } from "./transcript-anchor";

type Frame = (time: number) => void;

const originalAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const originalCss = globalThis.CSS;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);
let frames: Frame[];

beforeEach(() => {
  frames = [];
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value: string) => value },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: originalCss,
  });
  if (originalWindowDescriptor)
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

function element(top: number): HTMLElement {
  const node: HTMLElement = Object.create(null);
  return Object.assign(node, {
    getBoundingClientRect: () => ({ top }),
  });
}

function container(target: HTMLElement | null) {
  let currentTarget = target;
  const listeners = new Map<string, EventListener>();
  const node: HTMLElement = Object.create(null);
  Object.assign(node, {
    isConnected: true,
    scrollTop: 200,
    scrollHeight: 1_000,
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelector: () => currentTarget,
    addEventListener: (type: string, listener: EventListener) => {
      listeners.set(type, listener);
    },
    removeEventListener: (type: string) => {
      listeners.delete(type);
    },
  });
  return {
    node,
    setTarget(next: HTMLElement | null) {
      currentTarget = next;
    },
    listenerCount: () => listeners.size,
  };
}

describe("transcript index anchor bridge", () => {
  test("corrects the replacement identity once, then yields to native anchoring", () => {
    const scroller = container(element(130));
    let found = 0;
    let stopped = 0;

    holdTranscriptAnchor(
      scroller.node,
      "visible-entry",
      20,
      100,
      () => found++,
      () => stopped++,
      0,
    );
    expect(frames).toHaveLength(1);

    frames.shift()?.(1);

    expect(scroller.node.scrollTop).toBe(210);
    expect(found).toBe(1);
    expect(stopped).toBe(1);
    expect(scroller.listenerCount()).toBe(0);
    expect(frames).toHaveLength(0);
  });

  test("uses bottom distance only until the replacement identity mounts", () => {
    const scroller = container(null);
    let found = 0;

    holdTranscriptAnchor(
      scroller.node,
      "visible-entry",
      20,
      100,
      () => found++,
      undefined,
      0,
    );
    frames.shift()?.(1);
    expect(scroller.node.scrollTop).toBe(700);
    expect(frames).toHaveLength(1);

    scroller.setTarget(element(130));
    frames.shift()?.(2);

    expect(scroller.node.scrollTop).toBe(710);
    expect(found).toBe(1);
    expect(frames).toHaveLength(0);
  });
});
