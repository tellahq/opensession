import { describe, expect, it } from "bun:test";
import { registerChartView } from "./chart-fence";
import {
  FENCE_UPGRADERS,
  fenceUpgraderFor,
  finalizeFenceUpgrades,
  REPLACED_FENCE_SELECTOR,
} from "./fence-upgraders";

describe("fence upgrader registry", () => {
  it("claims a fence by its lowercase language", () => {
    expect(fenceUpgraderFor("mermaid")?.langs).toContain("mermaid");
    expect(fenceUpgraderFor("Vega-Lite")?.langs).toContain("vega-lite");
    expect(fenceUpgraderFor("chart")?.langs).toContain("chart");
    expect(fenceUpgraderFor("palette")?.langs).toContain("palette");
    expect(fenceUpgraderFor("ts")).toBeUndefined();
    expect(fenceUpgraderFor(undefined)).toBeUndefined();
  });

  it("never claims the same language twice", () => {
    const seen = new Set<string>();
    for (const upgrader of FENCE_UPGRADERS) {
      for (const lang of upgrader.langs) {
        expect(lang).toBe(lang.toLowerCase());
        expect(seen.has(lang)).toBe(false);
        seen.add(lang);
      }
    }
  });

  it("lists every fence the copy control should leave alone", () => {
    expect(REPLACED_FENCE_SELECTOR).toContain(
      'code[class~="language-mermaid"]',
    );
    expect(REPLACED_FENCE_SELECTOR).toContain(
      'code[class~="language-vega-lite"]',
    );
    // A block that keeps its copy control is not in the skip list.
    for (const upgrader of FENCE_UPGRADERS) {
      if (!upgrader.keepsCodeControls) continue;
      for (const lang of upgrader.langs)
        expect(REPLACED_FENCE_SELECTOR).not.toContain(`language-${lang}"`);
    }
  });

  it("finalizes live blocks under a root through their upgrader", () => {
    const calls: string[] = [];
    const canvas = {
      matches: (selector: string) => selector === ".md-chart-canvas",
      querySelectorAll: () => [],
    };
    const root = {
      matches: () => false,
      querySelectorAll: (selector: string) =>
        selector === ".md-chart-canvas" ? [canvas] : [],
    };
    registerChartView(canvas, { finalize: () => calls.push("chart") });
    finalizeFenceUpgrades(root);
    expect(calls).toEqual(["chart"]);
    // Idempotent: a second pass finds nothing left to release.
    finalizeFenceUpgrades(root);
    expect(calls).toEqual(["chart"]);
  });
});
