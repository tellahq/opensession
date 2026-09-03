import { beforeEach, describe, expect, test } from "bun:test";
import { readBaseCss } from "../styles/base-css-test-support";
import {
  ACCENT_THEME_OPTIONS,
  type AccentTheme,
  DEFAULT_ACCENT_THEME,
  getAccentTheme,
  getAccentThemeOption,
  getOnAccentInk,
  handleAccentStorageChange,
  isAccentTheme,
  setAccentTheme,
} from "./accent-theme";

class StorageStub {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  clear() {
    this.values.clear();
  }
}

const storage = new StorageStub();
const dataset: Record<string, string> = {};

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: { documentElement: { dataset } },
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      dispatchEvent() {},
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
  });
  storage.clear();
  delete dataset.accent;
});

function contrast(a: string, b: string) {
  const [first, second] = [luminance(a), luminance(b)];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

describe("accent theme", () => {
  test("matches the native seven-colour palette", () => {
    expect(ACCENT_THEME_OPTIONS).toHaveLength(7);
    expect(
      new Set(ACCENT_THEME_OPTIONS.map(({ light, dark }) => `${light}-${dark}`))
        .size,
    ).toBe(7);
  });

  test("the CSS tokens and pre-paint bootstrap contain the same palette", async () => {
    const [css, html] = await Promise.all([
      readBaseCss(),
      Bun.file(new URL("../index.html", import.meta.url)).text(),
    ]);
    for (const option of ACCENT_THEME_OPTIONS) {
      const block = css.match(
        new RegExp(
          `html\\[data-accent="${option.value}"\\] \\{([\\s\\S]*?)\\}`,
        ),
      )?.[1];
      expect(block).toContain(`--accent-light: ${option.light}`);
      expect(block).toContain(`--accent-dark: ${option.dark}`);
    }
    const serializedValues = [
      ...(html.match(/var accents = \[([\s\S]*?)\];/)?.[1] ?? "").matchAll(
        /["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]);
    expect(serializedValues).toEqual(
      ACCENT_THEME_OPTIONS.map((option) => option.value),
    );
    // Black is the only accent that overrides the glyph, and the only one
    // whose fill inverts with the page.
    expect(css).toContain("--on-accent-light: #ffffff");
    expect(css).toContain("--on-accent-dark: #000000");
    expect(css).toContain("--accent-ink-light: #8d7110");
    // Honey cannot carry a control in either appearance, so it borrows the
    // blue outright; Black only needs it where its own fill turns white.
    const honey = css.match(/html\[data-accent="lime"\] \{([\s\S]*?)\}/)?.[1];
    expect(honey).toContain("--accent-control: #2495d6");
    expect(honey).toContain("--on-accent-control: #ffffff");
    const blackDark = css.match(
      /html\[data-theme="dark"\]\[data-accent="mono"\] \{([\s\S]*?)\}/,
    )?.[1];
    expect(blackDark).toContain("--accent-control: #2495d6");
    // The pre-paint bootstrap has to retire the same selections the bundle
    // does, or a migrated accent flashes its old id for one frame.
    expect(html).toMatch(
      /var retired = \{\s*gold: "lime",\s*purple: "coral",\s*pink: "coral",\s*brown: "orange",\s*teal: "sky",?\s*\}/,
    );
  });

  test("the picker keeps every accent in a compact labelled group", async () => {
    const panel = await Bun.file(
      new URL("../components/settings/AppearancePanel.tsx", import.meta.url),
    ).text();
    expect(panel).toContain("flex w-fit max-w-full flex-wrap gap-y-1");
    expect(panel).toContain("<Tooltip label={option.label}>");
    expect(panel).not.toContain("title={option.label}");
  });

  // Honey is the one deliberate exception, at 1.62:1. It is the pairing the
  // palette was drawn from, and it is only ever a glyph on a plate; a label
  // takes --accent-ink, which deepens until it clears text contrast. Asserting
  // the number rather than skipping the case keeps the exception visible.
  test("honey's white glyph is the one low-contrast pairing", () => {
    const honey = getAccentThemeOption("lime");
    expect(getOnAccentInk("lime", "light")).toBe("#ffffff");
    expect(contrast(honey.light, "#ffffff")).toBeCloseTo(1.62, 1);
  });

  test("every other fill carries a legible glyph", () => {
    for (const option of ACCENT_THEME_OPTIONS) {
      if (option.value === "lime") continue;
      for (const tone of ["light", "dark"] as const) {
        const fill = option[tone];
        const ink = getOnAccentInk(option.value, tone);
        expect(contrast(fill, ink)).toBeGreaterThan(3);
      }
    }
  });

  test("migrates the removed Gold accent to Lime", () => {
    storage.setItem("opensession-accent", "gold");
    expect(getAccentTheme()).toBe("lime");
    expect(storage.getItem("opensession-accent")).toBe("lime");
  });

  // A retired accent must never point at another retired one: the lookup runs
  // once, so a chain would leave the caller on a dead id and fall back to the
  // default, which is the reset the migration exists to prevent.
  test("migrates every retired accent to a hue still in the palette", () => {
    const retirements: [string, AccentTheme][] = [
      ["purple", "coral"],
      ["pink", "coral"],
      ["brown", "orange"],
      ["teal", "sky"],
      ["gold", "lime"],
    ];
    for (const [retired, expected] of retirements) {
      storage.setItem("opensession-accent", retired);
      expect(getAccentTheme()).toBe(expected);
      expect(isAccentTheme(expected)).toBe(true);
    }
  });

  test("defaults to sky for missing or unknown values", () => {
    expect(getAccentTheme()).toBe(DEFAULT_ACCENT_THEME);
    storage.setItem("opensession-accent", "chartreuse");
    expect(getAccentTheme()).toBe(DEFAULT_ACCENT_THEME);
  });

  test("persists and applies a selection", () => {
    setAccentTheme("coral");
    expect(getAccentTheme()).toBe("coral");
    expect(dataset.accent).toBe("coral");
  });

  test("a cross-tab storage clear restores the default", () => {
    dataset.accent = "coral";
    handleAccentStorageChange({ key: null });
    expect(dataset.accent).toBe(DEFAULT_ACCENT_THEME);
  });

  test("rejects values outside the palette", () => {
    expect(isAccentTheme("lime")).toBe(true);
    expect(isAccentTheme("gold")).toBe(false);
    expect(isAccentTheme("teal")).toBe(false);
    expect(isAccentTheme("chartreuse")).toBe(false);
    expect(getAccentThemeOption("mono").dark).toBe("#ffffff");
  });
});
