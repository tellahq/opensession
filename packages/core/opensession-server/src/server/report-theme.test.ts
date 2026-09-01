import { describe, expect, test } from "bun:test";
import {
  adaptReportHtml,
  authoredScheme,
  reportBaselineCss,
} from "./report-theme";

/** The declarations the document itself authored, not the injected baseline. */
function authoredCss(html: string): string {
  return [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)]
    .filter((m) => !m[1].includes("data-opensession-report-baseline"))
    .map((m) => m[2])
    .join("\n");
}

function hexLuminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [hexLuminance(a), hexLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function doc(css: string, body = "<p>Hello</p>"): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

const LIGHT_REPORT = doc(
  `body { background: #fff; color: #1f2430; }
	 .card { background: #f4f6f9; border: 1px solid #e3e6ee; }
	 .meta { color: #6b7280 }
	 a { color: #3b4fc0 }`,
);

describe("authoredScheme", () => {
  test("reads the page background the document paints", () => {
    expect(authoredScheme(LIGHT_REPORT)).toBe("light");
    expect(authoredScheme(doc("body{background:#0f1115;color:#e6e6e6}"))).toBe(
      "dark",
    );
  });

  test("resolves a background written as a custom property", () => {
    expect(
      authoredScheme(doc(":root{--bg:#11141a}body{background:var(--bg)}")),
    ).toBe("dark");
    expect(
      authoredScheme(
        doc(":root{--paper:#fafafa}body{background:var(--paper)}"),
      ),
    ).toBe("light");
  });

  test("a document with no background at all is light, like the browser", () => {
    expect(authoredScheme(doc("body{font-size:15px}"))).toBe("light");
  });

  test("color-scheme alone is enough to call a document dark", () => {
    expect(authoredScheme(doc(":root{color-scheme:dark}"))).toBe("dark");
  });

  test("a document that answers prefers-color-scheme handles itself", () => {
    expect(
      authoredScheme(
        doc(
          "body{background:#fff}@media (prefers-color-scheme: dark){body{background:#111}}",
        ),
      ),
    ).toBe("adaptive");
  });
});

describe("adaptReportHtml — light", () => {
  test("serves the authored colours untouched", () => {
    const out = adaptReportHtml(LIGHT_REPORT, "light");
    expect(authoredCss(out)).toContain("background: #fff");
    expect(authoredCss(out)).toContain("color: #1f2430");
  });

  test("still injects the baseline, ahead of the document's own styles", () => {
    const out = adaptReportHtml(LIGHT_REPORT, "light");
    expect(out).toContain("data-opensession-report-baseline");
    expect(out.indexOf("data-opensession-report-baseline")).toBeLessThan(
      out.indexOf("body { background: #fff"),
    );
  });

  test("a dark document keeps its own scheme and gets the matching baseline", () => {
    const out = adaptReportHtml(
      doc("body{background:#0f1115;color:#eee}"),
      "light",
    );
    expect(authoredCss(out)).toContain("#0f1115");
    expect(out).toContain("color-scheme:dark");
  });
});

describe("adaptReportHtml — dark", () => {
  const out = adaptReportHtml(LIGHT_REPORT, "dark");
  const css = authoredCss(out);

  test("flips the page and its ink, and keeps them readable", () => {
    const page = css.match(/background:\s*(#[0-9a-f]{6})/i)![1];
    const ink = css.match(/color:\s*(#[0-9a-f]{6})/i)![1];
    expect(hexLuminance(page)).toBeLessThan(0.05);
    expect(contrast(page, ink)).toBeGreaterThan(4.5);
  });

  test("keeps a surface distinguishable from the page it sits on", () => {
    const page = css.match(/body\s*\{\s*background:\s*(#[0-9a-f]{6})/i)![1];
    const card = css.match(/\.card\s*\{\s*background:\s*(#[0-9a-f]{6})/i)![1];
    expect(card).not.toBe(page);
    expect(hexLuminance(card)).toBeGreaterThan(hexLuminance(page));
  });

  test("keeps hue, so a signal colour still signals", () => {
    const green = authoredCss(
      adaptReportHtml(doc(".ok{background:#dcfce7;color:#166534}"), "dark"),
    );
    const [, bg, fg] = green.match(
      /background:\s*(#[0-9a-f]{6});color:\s*(#[0-9a-f]{6})/i,
    )!;
    const hueIsGreen = (hex: string) => {
      const g = parseInt(hex.slice(3, 5), 16);
      return (
        g > parseInt(hex.slice(1, 3), 16) && g > parseInt(hex.slice(5, 7), 16)
      );
    };
    expect(hueIsGreen(bg)).toBe(true);
    expect(hueIsGreen(fg)).toBe(true);
    expect(contrast(bg, fg)).toBeGreaterThan(4.5);
  });

  test("flips named colours", () => {
    const flipped = authoredCss(
      adaptReportHtml(doc("body{background:white}"), "dark"),
    );
    expect(flipped).not.toContain("white");
    expect(hexLuminance(flipped.match(/(#[0-9a-f]{6})/i)![1])).toBeLessThan(
      0.05,
    );
  });

  test("flips rgb() and hsl(), and keeps alpha", () => {
    const flipped = authoredCss(
      adaptReportHtml(
        doc(".a{background:rgba(0, 0, 0, 0.06);color:hsl(220, 15%, 20%)}"),
        "dark",
      ),
    );
    expect(flipped).toContain("0.06)");
    expect(flipped).toMatch(/rgba\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}, 0\.06\)/);
  });

  test("leaves shadows alone, so nothing grows a white glow", () => {
    const flipped = authoredCss(
      adaptReportHtml(doc(".a{box-shadow:0 1px 2px rgba(0,0,0,.12)}"), "dark"),
    );
    expect(flipped).toContain("rgba(0,0,0,.12)");
  });

  test("never reaches inside url() or a string", () => {
    const source = doc(
      `.a{background:url('data:image/svg+xml;utf8,<svg fill="#ffffff"/>')}
			 .b::after{content:"#ffffff"}`,
    );
    const flipped = authoredCss(adaptReportHtml(source, "dark"));
    expect(flipped).toContain(`<svg fill="#ffffff"/>`);
    expect(flipped).toContain(`content:"#ffffff"`);
  });

  test("never rewrites a custom property whose name is a colour word", () => {
    // `var(--red)` becoming `var(--#fa0000)` breaks the reference, and the
    // chip that named it loses its fill with nothing to show for it.
    const flipped = authoredCss(
      adaptReportHtml(
        doc(
          ":root{--red:#b3342c;--red-bg:#f8ded8}.wrong{color:var(--red);background:var(--red-bg)}",
        ),
        "dark",
      ),
    );
    expect(flipped).toContain(
      ".wrong{color:var(--red);background:var(--red-bg)}",
    );
    // The values behind those names are still flipped.
    expect(flipped).not.toContain("#f8ded8");
  });

  test("never mistakes a selector for a colour", () => {
    const flipped = authoredCss(
      adaptReportHtml(doc(".red,a:hover{color:#111}"), "dark"),
    );
    expect(flipped).toContain(".red,a:hover{");
  });

  test("takes the document's own color-scheme with it", () => {
    const flipped = authoredCss(
      adaptReportHtml(
        doc(":root{color-scheme:light}body{background:#fff}"),
        "dark",
      ),
    );
    expect(flipped).toContain("color-scheme:dark");
  });

  test("flips a style attribute too", () => {
    const flipped = adaptReportHtml(
      doc("body{background:#fff}", `<p style="color:#1f2430">x</p>`),
      "dark",
    );
    expect(flipped).not.toContain(`style="color:#1f2430"`);
    expect(flipped).toMatch(/style="color:#[cde][0-9a-f]{5}"/);
  });

  test("a document already in the target scheme is passed straight through", () => {
    const source = doc("body{background:#0f1115;color:#e6e6e6}");
    expect(authoredCss(adaptReportHtml(source, "dark"))).toBe(
      authoredCss(source),
    );
  });
});

describe("adaptReportHtml — a document that themes itself", () => {
  const source = doc(
    `body{background:#fff;color:#111}
		 @media (prefers-color-scheme: dark){body{background:#111;color:#eee}}`,
  );

  test("forces its dark branch on rather than trusting the OS", () => {
    const css = authoredCss(adaptReportHtml(source, "dark"));
    expect(css).toContain("@media all{");
    expect(css).not.toContain("prefers-color-scheme");
    // Its own light colours are left exactly as authored underneath.
    expect(css).toContain("background:#fff");
  });

  test("forces it off in light", () => {
    const css = authoredCss(adaptReportHtml(source, "light"));
    expect(css).toContain("@media not all{");
  });
});

describe("adaptReportHtml — safety", () => {
  test("a document with no head still gets the baseline", () => {
    const out = adaptReportHtml("<p>bare</p>", "dark");
    expect(out).toContain("data-opensession-report-baseline");
    expect(out).toContain("<p>bare</p>");
  });

  test("keeps the document's content byte for byte", () => {
    const out = adaptReportHtml(LIGHT_REPORT, "dark");
    expect(out).toContain("<p>Hello</p>");
  });

  test("the baseline names a scheme and paints a canvas in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const css = reportBaselineCss(theme);
      expect(css).toContain(`color-scheme:${theme}`);
      expect(css).toMatch(/body\{[^}]*background:#[0-9a-f]{6}/);
    }
  });

  test("a document that wrote its own CSS keeps its own page", () => {
    // The measure is the one thing a baseline can win by default and reflow
    // a report that was laid out wide, because a document sets it on its own
    // wrapper rather than on body.
    const out = adaptReportHtml(
      doc(".wrap{max-width:1500px}body{margin:0;background:#f6f7f9}"),
      "dark",
    );
    const baseline = out.match(
      /<style data-opensession-report-baseline>([\s\S]*?)<\/style>/,
    )![1];
    expect(baseline).not.toMatch(/body\{[^}]*max-width/);
    // Colour and element styling still arrive.
    expect(baseline).toContain("color-scheme:dark");
    expect(baseline).toContain(".chip.positive");
  });

  test("a document with no CSS of its own gets the whole house page", () => {
    const baseline = adaptReportHtml("<h1>Bare</h1>", "dark").match(
      /<style data-opensession-report-baseline>([\s\S]*?)<\/style>/,
    )![1];
    expect(baseline).toContain("max-width:72ch");
  });

  test("the baseline leaves the root unpainted, so a document's own paper reaches the edges", () => {
    // A background on `html` blocks the body's from propagating to the
    // canvas, which shows as a seam past the end of the document's measure.
    expect(reportBaselineCss("dark")).not.toMatch(
      /(^|\})html\s*\{[^}]*background/,
    );
  });
});
