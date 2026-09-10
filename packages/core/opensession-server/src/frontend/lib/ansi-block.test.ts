import { describe, expect, it } from "bun:test";
import {
  ansiUpgrader,
  applySgr,
  baseColorName,
  claimsAnsi,
  color256,
  parseAnsi,
  renderAnsiHtml,
  terminalSource,
} from "./ansi-block";

const ESC = "\u001b";

const text = (input: string) =>
  parseAnsi(input)
    .map((s) => s.text)
    .join("");

describe("claimsAnsi", () => {
  it("always claims an explicit ansi or terminal fence", () => {
    expect(claimsAnsi("ansi", "plain")).toBe(true);
    expect(claimsAnsi("terminal", "plain")).toBe(true);
  });

  it("claims a shell or text fence only when it carries a real escape", () => {
    expect(claimsAnsi("bash", `${ESC}[32mok${ESC}[0m`)).toBe(true);
    expect(claimsAnsi("console", `${ESC}[1m`)).toBe(true);
    expect(claimsAnsi("text", `${ESC}[K`)).toBe(true);
    expect(claimsAnsi("bash", "echo '\\x1b[32m'")).toBe(false);
    expect(claimsAnsi("bash", "ls -la")).toBe(false);
    expect(claimsAnsi("json", `${ESC}[31m`)).toBe(false);
  });

  it("is what the registered upgrader claims with", () => {
    expect(ansiUpgrader.claims).toBe(claimsAnsi);
    expect(ansiUpgrader.keepsCodeControls).toBe(true);
    expect(ansiUpgrader.langs).toEqual(["ansi", "terminal"]);
  });
});

describe("terminalSource", () => {
  it("decodes spelled escapes in an explicit fence that has no real ones", () => {
    expect(
      terminalSource("ansi", "\\x1b[31mred\\e[0m \\033[1mb\\u001b[m"),
    ).toBe(`${ESC}[31mred${ESC}[0m ${ESC}[1mb${ESC}[m`);
  });

  it("leaves a fence with real escapes, or a shell fence, alone", () => {
    const real = `${ESC}[31m\\x1b[0m`;
    expect(terminalSource("ansi", real)).toBe(real);
    expect(terminalSource("bash", "echo '\\x1b[31m'")).toBe("echo '\\x1b[31m'");
  });

  it("only decodes a spelling that opens a CSI", () => {
    expect(terminalSource("terminal", "path\\extra \\e is fine")).toBe(
      "path\\extra \\e is fine",
    );
  });
});

describe("parseAnsi", () => {
  it("returns plain text as one unstyled span", () => {
    expect(parseAnsi("hello\nworld")).toEqual([
      {
        text: "hello\nworld",
        style: expect.objectContaining({ bold: false, fg: null, bg: null }),
      },
    ]);
    expect(parseAnsi("")).toEqual([]);
  });

  it("splits on SGR changes and resets", () => {
    const spans = parseAnsi(`a ${ESC}[1;31mb${ESC}[0m c`);
    expect(spans.map((s) => s.text)).toEqual(["a ", "b", " c"]);
    expect(spans[1]!.style.bold).toBe(true);
    expect(spans[1]!.style.fg).toEqual({ kind: "base", index: 1 });
    expect(spans[2]!.style.bold).toBe(false);
    expect(spans[2]!.style.fg).toBeNull();
  });

  it("treats an empty parameter list as a reset", () => {
    const spans = parseAnsi(`${ESC}[32mgreen${ESC}[mplain`);
    expect(spans[1]!.style.fg).toBeNull();
  });

  it("reads bright, 256-colour and 24-bit colours", () => {
    const spans = parseAnsi(
      `${ESC}[91ma${ESC}[38;5;208mb${ESC}[48;2;10;20;30mc${ESC}[38:2::1:2:3md`,
    );
    expect(spans[0]!.style.fg).toEqual({ kind: "base", index: 9 });
    expect(spans[1]!.style.fg).toEqual({ kind: "rgb", r: 255, g: 135, b: 0 });
    expect(spans[2]!.style.bg).toEqual({ kind: "rgb", r: 10, g: 20, b: 30 });
    expect(spans[3]!.style.fg).toEqual({ kind: "rgb", r: 1, g: 2, b: 3 });
    // The colour set before the background stays in force.
    expect(spans[2]!.style.fg).toEqual({ kind: "rgb", r: 255, g: 135, b: 0 });
  });

  it("turns individual attributes back off", () => {
    const spans = parseAnsi(
      `${ESC}[1;2;3;4;7;9mx${ESC}[22;23;24;27;29my${ESC}[44mz${ESC}[49;39mw`,
    );
    expect(spans[0]!.style).toMatchObject({
      bold: true,
      dim: true,
      italic: true,
      underline: true,
      inverse: true,
      strike: true,
    });
    expect(spans[1]!.style).toMatchObject({
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
      strike: false,
    });
    expect(spans[2]!.style.bg).toEqual({ kind: "base", index: 4 });
    expect(spans[3]!.style.bg).toBeNull();
  });

  it("strips every other escape", () => {
    expect(
      text(
        `${ESC}[2J${ESC}[H${ESC}[?25lline${ESC}[K${ESC}[1A${ESC}]0;title${ESC}\\ ` +
          `${ESC}]8;;https://x${"\u0007"}link${ESC}(B${ESC}7 end${ESC}`,
      ),
    ).toBe("line link end");
  });

  it("ignores a malformed colour instead of misreading what follows", () => {
    const spans = parseAnsi(`${ESC}[38;5;999mx${ESC}[38;2;1mz`);
    expect(spans[0]!.style.fg).toBeNull();
    expect(spans[1]!.style.fg).toBeNull();
    expect(text(`${ESC}[38;9mafter`)).toBe("after");
  });

  it("keeps the active colour when an extended colour is malformed", () => {
    const spans = parseAnsi(
      `${ESC}[31;44mred ${ESC}[38;5;999mstill red ${ESC}[48;2;1;2mstill blue`,
    );
    expect(spans.map((s) => s.style.fg)).toEqual([
      { kind: "base", index: 1 },
      { kind: "base", index: 1 },
      { kind: "base", index: 1 },
    ]);
    expect(spans.map((s) => s.style.bg)).toEqual([
      { kind: "base", index: 4 },
      { kind: "base", index: 4 },
      { kind: "base", index: 4 },
    ]);
  });
});

describe("applySgr and color256", () => {
  it("maps the cube and the grey ramp", () => {
    expect(color256(0)).toEqual({ kind: "base", index: 0 });
    expect(color256(15)).toEqual({ kind: "base", index: 15 });
    expect(color256(16)).toEqual({ kind: "rgb", r: 0, g: 0, b: 0 });
    expect(color256(231)).toEqual({ kind: "rgb", r: 255, g: 255, b: 255 });
    expect(color256(232)).toEqual({ kind: "rgb", r: 8, g: 8, b: 8 });
    expect(color256(255)).toEqual({ kind: "rgb", r: 238, g: 238, b: 238 });
    expect(color256(256)).toBeNull();
    expect(color256(-1)).toBeNull();
  });

  it("does not mutate the style it is given", () => {
    const base = applySgr("", {
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      strike: false,
      inverse: false,
      hidden: false,
      fg: null,
      bg: null,
    });
    const next = applySgr("1;31", base);
    expect(base.bold).toBe(false);
    expect(next.bold).toBe(true);
  });

  it("names the sixteen base colours", () => {
    expect(baseColorName(0)).toBe("black");
    expect(baseColorName(1)).toBe("red");
    expect(baseColorName(7)).toBe("white");
    expect(baseColorName(8)).toBe("bright-black");
    expect(baseColorName(15)).toBe("bright-white");
  });
});

describe("renderAnsiHtml", () => {
  it("escapes text and leaves unstyled runs bare", () => {
    expect(renderAnsiHtml(parseAnsi(`<b> & "q"`))).toBe(
      "&lt;b&gt; &amp; &quot;q&quot;",
    );
  });

  it("writes base colours as classes and data colours as rgb()", () => {
    expect(
      renderAnsiHtml(parseAnsi(`${ESC}[1;4;91mhi${ESC}[0m${ESC}[38;5;208mx`)),
    ).toBe(
      '<span class="ansi-bold ansi-underline ansi-fg ansi-fg-bright-red">hi</span>' +
        '<span class="ansi-fg" style="color:rgb(255,135,0)">x</span>',
    );
  });

  it("marks an inline background so the contrast rule can see it", () => {
    expect(renderAnsiHtml(parseAnsi(`${ESC}[48;2;255;255;0mwarning`))).toBe(
      '<span class="ansi-bg" style="background-color:rgb(255,255,0)">warning</span>',
    );
  });

  it("emits no ink for concealed text, whatever colour it carries", () => {
    expect(renderAnsiHtml(parseAnsi(`${ESC}[8;31msecret`))).toBe(
      '<span class="ansi-hidden">secret</span>',
    );
    expect(renderAnsiHtml(parseAnsi(`${ESC}[8;38;2;9;9;9;44msecret`))).toBe(
      '<span class="ansi-hidden ansi-bg ansi-bg-blue">secret</span>',
    );
    expect(renderAnsiHtml(parseAnsi(`${ESC}[8;7;31msecret`))).toBe(
      '<span class="ansi-hidden ansi-inverse ansi-bg ansi-bg-red">secret</span>',
    );
  });

  it("swaps the sides of an inverse run", () => {
    expect(renderAnsiHtml(parseAnsi(`${ESC}[7;32mok`))).toBe(
      '<span class="ansi-inverse ansi-bg ansi-bg-green">ok</span>',
    );
    expect(renderAnsiHtml(parseAnsi(`${ESC}[7;32;44mok`))).toBe(
      '<span class="ansi-inverse ansi-fg ansi-fg-blue ansi-bg ansi-bg-green">ok</span>',
    );
  });

  it("never lets escaped text reach an attribute", () => {
    const html = renderAnsiHtml(
      parseAnsi(`${ESC}[31m"><script>alert(1)</script>`),
    );
    expect(html).toBe(
      '<span class="ansi-fg ansi-fg-red">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</span>',
    );
  });
});
