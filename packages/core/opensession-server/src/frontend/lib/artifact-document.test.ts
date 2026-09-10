import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_DEFAULT_HEIGHT,
  ARTIFACT_HEIGHT_MESSAGE,
  ARTIFACT_MAX_HEIGHT,
  ARTIFACT_MIN_HEIGHT,
  artifactCsp,
  artifactHtmlDocument,
  artifactOptionsFromInfo,
  artifactSandbox,
  artifactSvgDocument,
  clampArtifactHeight,
  isCompleteHtmlDocument,
  artifactHeightMessageSchema,
  svgArtifactSize,
  type ArtifactTheme,
} from "./artifact-document";

const THEME: ArtifactTheme = {
  bg: "#1c1c1c",
  text: "#e9e9e9",
  link: "#6ea8fe",
  font: "-apple-system, sans-serif",
  scheme: "dark",
};

describe("artifact options", () => {
  test("scripts are off unless the info string says so", () => {
    expect(artifactOptionsFromInfo("artifact").scripts).toBe(false);
    expect(artifactOptionsFromInfo("artifact scripts").scripts).toBe(true);
    expect(artifactOptionsFromInfo("Artifact SCRIPTS").scripts).toBe(true);
    expect(artifactOptionsFromInfo("artifact script").scripts).toBe(false);
    expect(artifactOptionsFromInfo(undefined).scripts).toBe(false);
  });

  test("the sandbox never grants same-origin, navigation, forms or popups", () => {
    expect(artifactSandbox({ scripts: false })).toBe("");
    expect(artifactSandbox({ scripts: true })).toBe("allow-scripts");
  });

  test("the policy blocks the network and opens scripts only on request", () => {
    const off = artifactCsp({ scripts: false });
    expect(off).toContain("default-src 'none'");
    expect(off).toContain("img-src data:");
    expect(off).toContain("style-src 'unsafe-inline'");
    expect(off).not.toContain("script-src");
    expect(off).not.toMatch(/https?:/);
    const on = artifactCsp({ scripts: true });
    expect(on).toContain("script-src 'unsafe-inline'");
    expect(on).toContain("default-src 'none'");
    expect(on).not.toContain("connect-src");
  });
});

describe("artifact html document", () => {
  test("wraps a fragment in a document carrying the page's colours", () => {
    const doc = artifactHtmlDocument("<h1>Hi</h1>", { scripts: false }, THEME);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("background:#1c1c1c");
    expect(doc).toContain("color:#e9e9e9");
    expect(doc).toContain("color-scheme:dark");
    expect(doc).toContain("<body><h1>Hi</h1></body>");
    expect(doc).not.toContain("<script");
  });

  test("splices the policy into a complete document's head, first", () => {
    const doc = artifactHtmlDocument(
      "<!DOCTYPE html><html><head><title>T</title><style>body{color:red}</style></head><body>x</body></html>",
      { scripts: false },
      THEME,
    );
    expect(isCompleteHtmlDocument(doc)).toBe(true);
    const csp = doc.indexOf("Content-Security-Policy");
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(doc.indexOf("<title>"));
    // The author's own rules come after the base style, so they win.
    expect(doc.indexOf("background:#1c1c1c")).toBeLessThan(
      doc.indexOf("body{color:red}"),
    );
  });

  test("gives a headless <html> document a head", () => {
    const doc = artifactHtmlDocument(
      "<html><body>x</body></html>",
      { scripts: false },
      THEME,
    );
    expect(doc).toMatch(/<html><head><meta http-equiv/);
  });

  test("adds the height reporter only with scripts on", () => {
    const off = artifactHtmlDocument("<p>a</p>", { scripts: false }, THEME);
    const on = artifactHtmlDocument("<p>a</p>", { scripts: true }, THEME);
    expect(off).not.toContain("postMessage");
    expect(on).toContain("postMessage");
    expect(on).toContain("ResizeObserver");
  });

  test("a theme value cannot break out of the style block", () => {
    const doc = artifactHtmlDocument(
      "<p>a</p>",
      { scripts: false },
      { ...THEME, bg: "</style><script>1</script>" },
    );
    expect(doc).not.toContain("<script>1</script>");
  });

  test("a streaming fragment still becomes a document", () => {
    const doc = artifactHtmlDocument("<div><p>half", { scripts: false }, THEME);
    expect(doc).toContain("<body><div><p>half</body>");
  });
});

describe("svg artifact document", () => {
  const svg =
    '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>';

  test("shows the drawing as an image, never as live markup", () => {
    const doc = artifactSvgDocument(svg, THEME);
    expect(doc).toContain('<img src="data:image/svg+xml;charset=utf-8,');
    expect(doc).not.toContain("<svg");
    expect(doc).not.toContain("script-src");
  });

  test("reads the drawing's own size past an xml prolog", () => {
    expect(svgArtifactSize(svg)).toEqual({ w: 200, h: 100 });
    expect(svgArtifactSize("<svg><rect/></svg>")).toBeNull();
  });
});

describe("clampArtifactHeight", () => {
  test("keeps a reported height inside the range", () => {
    expect(clampArtifactHeight(10)).toBe(ARTIFACT_MIN_HEIGHT);
    expect(clampArtifactHeight(1e9)).toBe(ARTIFACT_MAX_HEIGHT);
    expect(clampArtifactHeight(400.4)).toBe(400);
    expect(clampArtifactHeight(Number.NaN)).toBe(ARTIFACT_DEFAULT_HEIGHT);
  });
});

describe("artifactHeightMessageSchema", () => {
  test("accepts only the frame's own message shape", () => {
    const ok = artifactHeightMessageSchema.safeParse({
      type: ARTIFACT_HEIGHT_MESSAGE,
      height: 480,
    });
    expect(ok.success && ok.data.height).toBe(480);
    for (const bad of [
      { type: ARTIFACT_HEIGHT_MESSAGE, height: "9" },
      { type: "other", height: 1 },
      "hello",
      null,
    ])
      expect(artifactHeightMessageSchema.safeParse(bad).success).toBe(false);
  });
});
