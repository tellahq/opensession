import { describe, expect, it } from "bun:test";
import { hexSwatchColor, isCssColor, parsePalette } from "./palette-block";

describe("isCssColor", () => {
  it("accepts every hex length a browser does", () => {
    for (const hex of ["#f08", "#f08c", "#ff0080", "#ff0080cc", "#FF0080"])
      expect(isCssColor(hex)).toBe(true);
    for (const hex of ["#f", "#ff", "#ff008", "#ff00800", "#ff0080ccc"])
      expect(isCssColor(hex)).toBe(false);
  });

  it("accepts colour functions with a flat argument list", () => {
    for (const value of [
      "rgb(255, 0, 128)",
      "rgba(255 0 128 / 0.5)",
      "hsl(330deg 100% 50%)",
      "hwb(330 0% 0%)",
      "oklch(0.7 0.2 340)",
      "oklch(70% 0.2 340 / 40%)",
      "lab(60 40 -20)",
      "color(display-p3 1 0 0.5)",
      "OKLCH(0.7 0.2 340)",
    ])
      expect(isCssColor(value)).toBe(true);
  });

  it("rejects computed colours, unknown functions and stray syntax", () => {
    for (const value of [
      "color-mix(in oklch, red, blue)",
      "rgb(calc(1 + 2) 0 0)",
      "var(--accent)",
      "url(x)",
      "rgb()",
      "rgb(   )",
      "oklch(0.7 0.2 340",
      "#ff0080; color: red",
      "rgb(0 0 0) }",
    ])
      expect(isCssColor(value)).toBe(false);
  });

  it("accepts named colours in any case, and nothing near them", () => {
    expect(isCssColor("rebeccapurple")).toBe(true);
    expect(isCssColor("Tomato")).toBe(true);
    expect(isCssColor("transparent")).toBe(true);
    expect(isCssColor("brand")).toBe(false);
    expect(isCssColor("currentcolor")).toBe(false);
    expect(isCssColor("")).toBe(false);
  });
});

describe("parsePalette", () => {
  it("reads a colour per line with the name after it", () => {
    expect(
      parsePalette("#ff0080 Brand pink\nrgb(0 0 0)\noklch(0.7 0.2 340) Rose"),
    ).toEqual([
      { value: "#ff0080", name: "Brand pink" },
      { value: "rgb(0 0 0)", name: "" },
      { value: "oklch(0.7 0.2 340)", name: "Rose" },
    ]);
  });

  it("reads the name before the colour", () => {
    expect(
      parsePalette(
        "Brand pink: #ff0080\nInk: rgb(20, 20, 20)\n--accent: tomato;\n",
      ),
    ).toEqual([
      { value: "#ff0080", name: "Brand pink" },
      { value: "rgb(20, 20, 20)", name: "Ink" },
      { value: "tomato", name: "--accent" },
    ]);
  });

  it("keeps a colon inside a trailing name", () => {
    expect(parsePalette("#ff0080 Brand: pink")).toEqual([
      { value: "#ff0080", name: "Brand: pink" },
    ]);
    // A colour name followed by a colon is a label, not a colour.
    expect(parsePalette("Red: #f00")).toEqual([{ value: "#f00", name: "Red" }]);
  });

  it("skips blank lines and trims whitespace", () => {
    expect(parsePalette("\n  #fff  White  \n\n#000\n")).toEqual([
      { value: "#fff", name: "White" },
      { value: "#000", name: "" },
    ]);
  });

  it("declines when any line is not a colour", () => {
    expect(parsePalette("#ff0080\nthis is prose")).toBeNull();
    expect(parsePalette("Brand: not a colour")).toBeNull();
    expect(parsePalette("#ff008 Brand")).toBeNull();
    expect(parsePalette(": #fff")).toBeNull();
    expect(parsePalette("")).toBeNull();
    expect(parsePalette("\n\n")).toBeNull();
  });
});

describe("hexSwatchColor", () => {
  it("takes only a whole six or eight digit hex", () => {
    expect(hexSwatchColor("#ff0080")).toBe("#ff0080");
    expect(hexSwatchColor("#FF0080CC")).toBe("#ff0080cc");
    expect(hexSwatchColor("#123")).toBeNull();
    expect(hexSwatchColor("#1234")).toBeNull();
    expect(hexSwatchColor("#5528")).toBeNull();
    expect(hexSwatchColor("#ff0080 ")).toBeNull();
    expect(hexSwatchColor("#gg0080")).toBeNull();
    expect(hexSwatchColor("ff0080")).toBeNull();
    expect(hexSwatchColor("#ff0080; color")).toBeNull();
  });
});
