import { afterEach, expect, test } from "bun:test";
import { copyImageToClipboard } from "./image-clipboard";

const navigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "ClipboardItem",
);
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (navigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
  if (clipboardItemDescriptor) {
    Object.defineProperty(globalThis, "ClipboardItem", clipboardItemDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "ClipboardItem");
  }
  globalThis.fetch = originalFetch;
});

test("starts the clipboard write before the image finishes loading", async () => {
  let wrote = false;
  let imagePromise: Promise<Blob> | undefined;
  class TestClipboardItem {
    constructor(items: Record<string, Promise<Blob>>) {
      imagePromise = items["image/png"];
    }
  }
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: TestClipboardItem,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        write: async () => {
          wrote = true;
          await imagePromise;
        },
      },
    },
  });
  const fetchImage = Object.assign(
    async () => new Response(new Blob(["png"], { type: "image/png" })),
    { preconnect() {} },
  );
  globalThis.fetch = fetchImage;

  const copying = copyImageToClipboard("/image.png");
  expect(wrote).toBe(true);
  expect(imagePromise).toBeInstanceOf(Promise);
  await copying;
  expect((await imagePromise)?.type).toBe("image/png");
});
