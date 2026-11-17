import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cn } from "./cn";

const tiers = [
  ...readFileSync(
    join(import.meta.dir, "../styles/smooth-shadow.css"),
    "utf8",
  ).matchAll(/@utility (smooth-shadow-[\w-]+)/g),
].map((m) => m[1]!);

describe("cn smooth shadows", () => {
  test("finds the stylesheet's tiers", () => {
    expect(tiers).toContain("smooth-shadow-xs");
    expect(tiers).toContain("smooth-shadow-ring-soft");
  });

  test.each(tiers)("a later shadow-none replaces %s", (tier) => {
    expect(cn(`border ${tier}`, "shadow-none")).toBe("border shadow-none");
  });

  test.each(tiers)("%s replaces an earlier stock shadow", (tier) => {
    expect(cn("shadow-sm", tier)).toBe(tier);
  });

  test("tiers replace each other, and variants stay separate", () => {
    expect(cn("smooth-shadow-xs", "smooth-shadow-ring-md")).toBe(
      "smooth-shadow-ring-md",
    );
    expect(
      cn("enabled:hover:smooth-shadow-xs", "enabled:hover:shadow-none"),
    ).toBe("enabled:hover:shadow-none");
    expect(cn("smooth-shadow-sm", "phone:shadow-none")).toBe(
      "smooth-shadow-sm phone:shadow-none",
    );
  });

  test("a shadow colour does not drop the tier that reads it", () => {
    expect(cn("smooth-shadow-sm", "shadow-black/20")).toBe(
      "smooth-shadow-sm shadow-black/20",
    );
  });
});
