import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_DEFAULT_HEIGHT,
  ARTIFACT_MAX_HEIGHT,
  ARTIFACT_MIN_HEIGHT,
  ARTIFACT_SANDBOX,
  artifactCsp,
  artifactDocumentHead,
  artifactHtmlDocument,
  artifactSvgDocument,
  clampArtifactHeight,
  isCompleteHtmlDocument,
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

/** The reviewer's bypass attempt: a comment that looks like a head, ahead of
 *  the real one, followed by an image that would phone home. */
const FAKE_HEAD =
  '<!doctype html><!-- <head> --><html><head></head><body><img src="https://attacker.example/pixel"></body></html>';

describe("artifact sandbox and policy", () => {
  test("the sandbox is fully locked: no token is ever granted", () => {
    expect(ARTIFACT_SANDBOX).toBe("");
  });

  test("the policy blocks the network and never opens scripts", () => {
    const csp = artifactCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toMatch(/https?:/);
  });

  test("the head opens with charset, policy and link target, in that order", () => {
    const head = artifactDocumentHead(THEME);
    expect(
      head.startsWith('<!doctype html><html><head><meta charset="utf-8">'),
    ).toBe(true);
    expect(head.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
      head.indexOf('<base target="_blank">'),
    );
    expect(head.indexOf('<base target="_blank">')).toBeLessThan(
      head.indexOf("<style>"),
    );
    expect(head).not.toContain("<script");
  });
});

describe("artifact html document", () => {
  test("wraps a fragment in a document carrying the page's colours", () => {
    const doc = artifactHtmlDocument("<h1>Hi</h1>", THEME);
    expect(doc.startsWith(artifactDocumentHead(THEME))).toBe(true);
    expect(doc).toContain("background:#1c1c1c");
    expect(doc).toContain("color:#e9e9e9");
    expect(doc).toContain("color-scheme:dark");
    expect(doc.endsWith("</head><body><h1>Hi</h1></body></html>")).toBe(true);
    expect(doc).not.toContain("<script");
  });

  test("the policy precedes every byte of a complete document", () => {
    const source =
      '<!DOCTYPE html><html lang="en"><head><title>T</title><style>body{color:red}</style></head><body>x</body></html>';
    const doc = artifactHtmlDocument(source, THEME);
    const head = artifactDocumentHead(THEME);
    expect(doc).toBe(head + source);
    expect(isCompleteHtmlDocument(doc)).toBe(true);
    // The author's own rules come after the base style, so they win.
    expect(doc.indexOf("background:#1c1c1c")).toBeLessThan(
      doc.indexOf("body{color:red}"),
    );
  });

  test("nothing in the source can get in front of the policy", () => {
    for (const source of [
      FAKE_HEAD,
      "<html><body>x</body></html>",
      "<!doctype html><!-- <html> --><p>x</p>",
      "<!DOCTYPE html>\n<!--\n<head>\n-->\n<html><head><meta name=x></head></html>",
    ]) {
      const doc = artifactHtmlDocument(source, THEME);
      const policy = doc.indexOf("Content-Security-Policy");
      expect(policy).toBeGreaterThan(-1);
      // The head is written before the first character of the source.
      expect(doc.indexOf(source)).toBe(artifactDocumentHead(THEME).length);
      expect(policy).toBeLessThan(doc.indexOf(source));
      // The block never writes a second policy or a second doctype: the
      // author's head is folded into the block's by the parser.
      expect(doc.split("Content-Security-Policy").length).toBe(2);
    }
  });

  test("a theme value cannot break out of the style block", () => {
    const doc = artifactHtmlDocument("<p>a</p>", {
      ...THEME,
      bg: "</style><script>1</script>",
    });
    expect(doc).not.toContain("<script>1</script>");
  });

  test("a streaming fragment still becomes a document", () => {
    const doc = artifactHtmlDocument("<div><p>half", THEME);
    expect(doc).toContain("<body><div><p>half</body>");
  });
});

describe("svg artifact document", () => {
  const svg =
    '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>';

  test("shows the drawing as an image, never as live markup", () => {
    const doc = artifactSvgDocument(svg, THEME);
    expect(doc.startsWith(artifactDocumentHead(THEME))).toBe(true);
    expect(doc).toContain('<img src="data:image/svg+xml;charset=utf-8,');
    expect(doc).not.toContain("<svg");
    expect(doc).not.toContain("<script");
  });

  test("reads the drawing's own size past an xml prolog", () => {
    expect(svgArtifactSize(svg)).toEqual({ w: 200, h: 100 });
    expect(svgArtifactSize("<svg><rect/></svg>")).toBeNull();
  });
});

describe("clampArtifactHeight", () => {
  test("keeps a dragged height inside the range", () => {
    expect(clampArtifactHeight(10)).toBe(ARTIFACT_MIN_HEIGHT);
    expect(clampArtifactHeight(1e9)).toBe(ARTIFACT_MAX_HEIGHT);
    expect(clampArtifactHeight(400.4)).toBe(400);
    expect(clampArtifactHeight(Number.NaN)).toBe(ARTIFACT_DEFAULT_HEIGHT);
  });
});
