import { describe, expect, test } from "bun:test";
import { diagramDataUrl, readDiagramSvg } from "./diagram-media";

/** What mermaid actually emits: a root sized to the column it rendered into,
 * an id its own <style> block is scoped by, and markers referenced by url(#…). */
const MERMAID = [
  '<svg id="os-mmd-1" width="100%" xmlns="http://www.w3.org/2000/svg"',
  ' viewBox="0 0 812 430" style="max-width: 812px; background-color: white;"',
  ' class="flowchart" role="graphics-document document">',
  "<style>#os-mmd-1{font-family:trebuchet ms}</style>",
  '<g><path stroke-width="2" marker-end="url(#os-mmd-1_arrow)"/></g>',
  "</svg>",
].join("");

describe("readDiagramSvg", () => {
  const read = readDiagramSvg(MERMAID);

  test("reports the diagram's own coordinate size, not the rendered column", () => {
    expect(read?.size).toEqual({ w: 812, h: 430 });
  });

  test("replaces the fluid width with that size, so it can be drawn at any scale", () => {
    expect(read?.svg).toContain('width="812"');
    expect(read?.svg).toContain('height="430"');
    expect(read?.svg).not.toContain('width="100%"');
  });

  test("drops the inline max-width, which no class in the viewer could beat", () => {
    expect(read?.svg).not.toContain("max-width");
  });

  test("keeps the rest of the inline style", () => {
    expect(read?.svg).toContain("background-color: white");
  });

  test("keeps the id, the scoped style block and the marker refs", () => {
    expect(read?.svg).toContain('id="os-mmd-1"');
    expect(read?.svg).toContain(
      "<style>#os-mmd-1{font-family:trebuchet ms}</style>",
    );
    expect(read?.svg).toContain('marker-end="url(#os-mmd-1_arrow)"');
  });

  test("leaves the body alone, stroke-width included", () => {
    expect(read?.svg).toContain('stroke-width="2"');
  });

  test("keeps a stroke-width on the root itself", () => {
    const out = readDiagramSvg(
      '<svg viewBox="0 0 10 5" stroke-width="1.5"></svg>',
    );
    expect(out?.svg).toContain('stroke-width="1.5"');
  });

  test("falls back to the width/height attributes when there is no viewBox", () => {
    const out = readDiagramSvg('<svg width="300" height="150"></svg>');
    expect(out?.size).toEqual({ w: 300, h: 150 });
  });

  test("is null for markup that is not a sized diagram", () => {
    expect(readDiagramSvg("<p>not a diagram</p>")).toBeNull();
    expect(readDiagramSvg('<svg class="empty"></svg>')).toBeNull();
    expect(readDiagramSvg('<svg viewBox="0 0 0 0"></svg>')).toBeNull();
  });
});

describe("diagramDataUrl", () => {
  test("survives labels outside Latin-1, which btoa would throw on", () => {
    const url = diagramDataUrl("<svg><text>Prüfung ✓ 日本語</text></svg>");
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.split(",")[1])).toContain("Prüfung ✓ 日本語");
  });
});
