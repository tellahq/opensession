import { afterEach, expect, test } from "bun:test";
import {
  pickViewportAnchor,
  rememberTranscriptScroll,
  rememberedTranscriptScroll,
} from "./transcript-scroll-memory";

const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);

afterEach(() => {
  if (originalDocument)
    Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

test("a reader at the live edge forgets the remembered position", () => {
  const position = { anchorEid: "e1", anchorTop: 12, scrollTop: 400 };
  rememberTranscriptScroll("acme-1", position);
  expect(rememberedTranscriptScroll("acme-1")).toEqual(position);
  rememberTranscriptScroll("acme-1", null);
  expect(rememberedTranscriptScroll("acme-1")).toBeNull();
});

test("memory stays bounded and drops the least recently saved session", () => {
  for (let i = 0; i < 201; i++)
    rememberTranscriptScroll(`acme-${i}`, {
      anchorEid: null,
      anchorTop: 0,
      scrollTop: i,
    });
  expect(rememberedTranscriptScroll("acme-0")).toBeNull();
  expect(rememberedTranscriptScroll("acme-200")?.scrollTop).toBe(200);
});

type FakeNode = {
  dataset?: { eid: string };
  closest?: () => HTMLElement | null;
  getBoundingClientRect?: () => {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  contains?: (node: Element) => boolean;
};

function fake(props: FakeNode): HTMLElement {
  const node: HTMLElement = Object.create(null);
  return Object.assign(node, props);
}

test("the anchor is the deepest entry under the top edge, seen through overlays", () => {
  const row = fake({ dataset: { eid: "row" } });
  const header = fake({ closest: () => null });
  const text = fake({ closest: () => row });
  const inside = new Set<Element>([row, text]);
  const container = fake({
    getBoundingClientRect: () => ({
      left: 0,
      top: 100,
      width: 400,
      height: 600,
    }),
    contains: (node: Element) => inside.has(node),
  });
  const points: Array<[number, number]> = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      elementsFromPoint: (x: number, y: number) => {
        points.push([x, y]);
        // The first sample falls in a gap between rows.
        return points.length === 1 ? [header] : [header, text];
      },
    },
  });
  expect(pickViewportAnchor(container)).toBe(row);
  expect(points).toEqual([
    [200, 108],
    [100, 108],
  ]);
});
