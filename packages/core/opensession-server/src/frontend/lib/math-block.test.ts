import { describe, expect, it } from "bun:test";
import katex from "katex";
import {
  displayMathBlockStart,
  inlineMathStart,
  matchDisplayMathBlock,
  matchInlineMath,
  mathPlaceholder,
  renderMathHtml,
} from "./math-block";

describe("inline math grammar", () => {
  it("matches an expression the delimiters touch", () => {
    expect(matchInlineMath("$x^2$ and more")).toEqual({
      raw: "$x^2$",
      source: "x^2",
      display: false,
    });
    expect(matchInlineMath("$\\frac{a}{b}$.")?.source).toBe("\\frac{a}{b}");
  });

  it("typesets a one-line $$...$$ in display mode", () => {
    expect(matchInlineMath("$$E = mc^2$$ rest")).toEqual({
      raw: "$$E = mc^2$$",
      source: "E = mc^2",
      display: true,
    });
  });

  it("leaves prices alone", () => {
    for (const prose of [
      "$1.84",
      "$5 to $10",
      "$5 to $10 each",
      "$5-$10",
      "$5, $10 and $20.",
      "$3 costs",
      "$ x$",
      "$x $",
      "$$",
      "$",
    ]) {
      expect(matchInlineMath(prose)).toBeUndefined();
    }
  });

  it("never matches across a line", () => {
    expect(matchInlineMath("$a\nb$")).toBeUndefined();
  });

  it("points marked at a candidate opener and skips glued dollars", () => {
    expect(inlineMathStart("see $x$")).toBe(4);
    expect(inlineMathStart("see $$x$$")).toBe(4);
    expect(inlineMathStart("US$5$")).toBeUndefined();
    expect(inlineMathStart("costs \\$x$")).toBeUndefined();
    expect(inlineMathStart("costs $ x")).toBeUndefined();
  });
});

describe("display math block grammar", () => {
  it("matches $$ on its own lines", () => {
    expect(matchDisplayMathBlock("$$\n\\int_0^1 x\\,dx\n$$\nafter")).toEqual({
      raw: "$$\n\\int_0^1 x\\,dx\n$$",
      source: "\\int_0^1 x\\,dx",
    });
    expect(matchDisplayMathBlock("$$  \na\nb\n  $$")?.source).toBe("a\nb");
  });

  it("needs a closing line", () => {
    expect(matchDisplayMathBlock("$$\nx")).toBeUndefined();
    expect(matchDisplayMathBlock("$$ x $$")).toBeUndefined();
    expect(matchDisplayMathBlock("$$\nx\n$$y")).toBeUndefined();
  });

  it("reports where a later block starts, only when it is complete", () => {
    expect(displayMathBlockStart("text\n$$\nx\n$$")).toBe(5);
    expect(displayMathBlockStart("text\n$$\nx")).toBeUndefined();
  });
});

describe("mathPlaceholder", () => {
  it("escapes the source into the attribute and keeps it as text", () => {
    const html = mathPlaceholder({
      raw: '$a<b "c"$',
      source: 'a<b "c"',
      display: false,
    });
    expect(html).toBe(
      '<span class="md-math" data-math="a&lt;b &quot;c&quot;">$a&lt;b &quot;c&quot;$</span>',
    );
    expect(
      mathPlaceholder({ raw: "$$x$$", source: "x", display: true }),
    ).toContain('data-display=""');
  });
});

describe("renderMathHtml", () => {
  it("writes MathML only, in display or inline mode", () => {
    const inline = renderMathHtml(katex, "x^2", false);
    expect(inline).toContain("<math");
    expect(inline).not.toContain('class="katex-html"');
    expect(inline).not.toContain('display="block"');
    expect(renderMathHtml(katex, "x^2", true)).toContain('display="block"');
  });

  it("declines what does not parse instead of showing red text", () => {
    expect(renderMathHtml(katex, "\\frac{a}{", true)).toBeNull();
    expect(renderMathHtml(katex, "   ", true)).toBeNull();
  });

  it("keeps trust off so links and images stay out", () => {
    // With trust off KaTeX typesets the command's name instead of obeying
    // it; the source only survives as inert text in the <annotation>.
    const html = renderMathHtml(katex, "\\href{javascript:x}{y}", false);
    expect(html).not.toBeNull();
    expect(html).not.toContain("href=");
    expect(html).not.toMatch(/<a\b/);
  });
});
