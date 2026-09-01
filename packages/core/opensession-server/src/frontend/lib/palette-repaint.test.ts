import { afterEach, describe, expect, test } from "bun:test";
import { repairDesktopPalettePaint } from "./palette-repaint";

const originalDocument = globalThis.document;

afterEach(async () => {
  await Promise.resolve();
  Object.defineProperty(globalThis, "document", {
    value: originalDocument,
    configurable: true,
  });
});

describe("desktop palette repaint", () => {
  test("coalesces palette changes into one synchronous paint-tree reset", async () => {
    const writes: string[] = [];
    let layoutReads = 0;
    const style = {
      getPropertyValue: () => "flex",
      getPropertyPriority: () => "",
      setProperty: (_name: string, value: string) => writes.push(value),
      removeProperty: () => writes.push("removed"),
    };
    const app = {
      style,
      get offsetHeight() {
        layoutReads++;
        return 900;
      },
    };
    Object.defineProperty(globalThis, "document", {
      value: {
        documentElement: {
          classList: { contains: (name: string) => name === "desktop-shell" },
        },
        querySelector: (selector: string) => (selector === ".app" ? app : null),
      },
      configurable: true,
    });

    repairDesktopPalettePaint();
    repairDesktopPalettePaint();
    expect(layoutReads).toBe(0);

    await Promise.resolve();

    expect(writes).toEqual(["none", "flex"]);
    expect(layoutReads).toBe(1);
  });

  test("does not disturb ordinary browser layouts", async () => {
    let queried = false;
    Object.defineProperty(globalThis, "document", {
      value: {
        documentElement: { classList: { contains: () => false } },
        querySelector: () => {
          queried = true;
          return null;
        },
      },
      configurable: true,
    });

    repairDesktopPalettePaint();
    await Promise.resolve();

    expect(queried).toBe(false);
  });
});
