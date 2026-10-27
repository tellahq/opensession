import { describe, expect, test } from "bun:test";
import {
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  HTML_THEME_DEFAULTS,
  HTML_THEME_TOKENS,
  htmlRenderFrameHeight,
  htmlRenderFromResult,
  htmlRendersFromResult,
  htmlThemeFragment,
  mayBeHtmlRenderTool,
  readHtmlContentHeight,
  readHtmlLinkRequest,
  readHtmlRenderReference,
  type HtmlRenderReference,
} from "./html-render";

const URL_OK = "/api/sessions/os-1/assets/raw/html-renders/fit-abc.html";

describe("readHtmlRenderReference", () => {
  test("accepts a stored render and clamps its numbers", () => {
    expect(
      readHtmlRenderReference({
        url: URL_OK,
        path: "html-renders/fit-abc.html",
        title: "  Fit  ",
        height: 9999,
        heights: [
          [744, 500],
          [320, 10],
        ],
      }),
    ).toEqual({
      url: URL_OK,
      path: "html-renders/fit-abc.html",
      title: "Fit",
      height: HTML_RENDER_MAX_HEIGHT,
      heights: [
        [320, HTML_RENDER_MIN_HEIGHT],
        [744, 500],
      ],
    });
  });

  test("never frames anything but a stored render", () => {
    for (const url of [
      "https://evil.example/x.html",
      "/api/sessions/os-1/assets/raw/reports/x.html",
      "/api/sessions/os-1/assets/raw/html-renders/x.js",
      "//evil.example/api/sessions/a/assets/raw/html-renders/x.html",
      "javascript:alert(1)",
    ])
      expect(
        readHtmlRenderReference({ url, path: "p", title: "t", height: 300 }),
      ).toBeUndefined();
  });

  test("drops malformed measurements rather than the render", () => {
    const ref = readHtmlRenderReference({
      url: URL_OK,
      path: "p",
      title: "t",
      height: 300,
      heights: [[744, "tall"]],
    });
    expect(ref?.heights).toBeUndefined();
  });
});

describe("htmlRenderFromResult", () => {
  const body = {
    htmlRender: { url: URL_OK, path: "p", title: "t", height: 300 },
    message: "Shown inline.",
  };

  test("reads the tool's JSON answer", () => {
    expect(htmlRenderFromResult(JSON.stringify(body))?.url).toBe(URL_OK);
  });

  test("reads it inside a dispatcher's prose", () => {
    expect(
      htmlRenderFromResult(`Result:\n${JSON.stringify(body)}\n`)?.title,
    ).toBe("t");
  });

  test("ignores anything else", () => {
    expect(htmlRenderFromResult("Render failed: no")).toBeUndefined();
    expect(htmlRenderFromResult(undefined)).toBeUndefined();
    expect(htmlRenderFromResult('{"htmlRender":{"url":"/x"}}')).toBeUndefined();
  });
});

describe("htmlRendersFromResult", () => {
  const answer = (url: string, title: string) =>
    JSON.stringify({
      htmlRender: { url, path: "p", title, height: 300 },
      message:
        "Shown inline in the session. Do not link to it or describe where it is.",
    });
  const URL_TWO = URL_OK.replace(".html", "-2.html");

  test("reads a codemode report around the answer", () => {
    const report = `Script completed\nWall time 1.8 seconds\nOutput:\n${answer(URL_OK, "Mockups")}\nConsole: {"log": 1}`;
    expect(htmlRendersFromResult(report).map((r) => r.title)).toEqual([
      "Mockups",
    ]);
  });

  test("reads an answer the script returned as a string", () => {
    const report = `Script completed\nOutput:\n${JSON.stringify(answer(URL_OK, 'Say "hi"'))}`;
    expect(htmlRenderFromResult(report)?.url).toBe(URL_OK);
  });

  test("reads every page a script showed, once each", () => {
    const report = `Output:\n${JSON.stringify([
      JSON.parse(answer(URL_OK, "One")),
      JSON.parse(answer(URL_TWO, "Two")),
      JSON.parse(answer(URL_OK, "One")),
    ])}`;
    expect(htmlRendersFromResult(report).map((r) => r.title)).toEqual([
      "One",
      "Two",
    ]);
  });

  test("ignores a reference that is not a stored render", () => {
    expect(
      htmlRendersFromResult(
        `Output: ${answer("https://evil.test/x.html", "x")}`,
      ),
    ).toEqual([]);
  });
});

describe("htmlRenderFrameHeight", () => {
  const ref: HtmlRenderReference = {
    url: URL_OK,
    path: "p",
    title: "t",
    height: 600,
    heights: [
      [320, 900],
      [744, 500],
      [1160, 400],
    ],
  };

  test("takes the taller neighbour between measured widths", () => {
    expect(htmlRenderFrameHeight(ref, 744)).toBe(500);
    expect(htmlRenderFrameHeight(ref, 500)).toBe(900);
    expect(htmlRenderFrameHeight(ref, 2000)).toBe(400);
  });

  test("the page's own report wins", () => {
    expect(htmlRenderFrameHeight(ref, 744, 512)).toBe(512);
  });

  test("an agent height below the page's caps the frame", () => {
    expect(htmlRenderFrameHeight({ ...ref, height: 300 }, 744)).toBe(300);
    expect(htmlRenderFrameHeight({ ...ref, height: 300 }, 744, 800)).toBe(300);
  });

  test("an unmeasured page uses the agent height until it reports", () => {
    const bare = { ...ref, heights: undefined };
    expect(htmlRenderFrameHeight(bare, 744)).toBe(600);
    expect(htmlRenderFrameHeight(bare, 744, 420)).toBe(420);
  });
});

describe("mayBeHtmlRenderTool", () => {
  test("direct calls and dispatcher calls", () => {
    expect(mayBeHtmlRenderTool("mcp__opensession-html__html_render")).toBe(
      true,
    );
    expect(
      mayBeHtmlRenderTool("mcp_call", {
        name: "opensession-html_html_render",
        arguments: {},
      }),
    ).toBe(true);
    expect(mayBeHtmlRenderTool("mcp__oc__mcp_call", { keys: ["name"] })).toBe(
      true,
    );
  });

  test("codemode scripts, which reach it through tools.mcp_call", () => {
    expect(mayBeHtmlRenderTool("codemode", { code: "…" })).toBe(true);
    expect(mayBeHtmlRenderTool("mcp__oc__codemode")).toBe(true);
  });

  test("not other tools", () => {
    expect(mayBeHtmlRenderTool("Bash")).toBe(false);
    expect(mayBeHtmlRenderTool("mcp__opensession-html__html_preview")).toBe(
      false,
    );
  });
});

describe("page messages", () => {
  test("size and link requests", () => {
    expect(
      readHtmlContentHeight({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: 412 },
      }),
    ).toBe(412);
    expect(readHtmlContentHeight({ method: "x" })).toBeUndefined();
    expect(
      readHtmlLinkRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "ui/open-link",
        params: { url: "https://example.test/a" },
      }),
    ).toEqual({ id: 1, url: "https://example.test/a" });
    expect(
      readHtmlLinkRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "ui/open-link",
        params: { url: "javascript:alert(1)" },
      }),
    ).toBeUndefined();
  });

  test("the theme fragment round-trips", () => {
    const fragment = htmlThemeFragment(HTML_THEME_DEFAULTS.light);
    const parsed = JSON.parse(
      decodeURIComponent(fragment.slice("#os-theme=".length)),
    );
    expect(parsed.appearance).toBe("light");
  });

  test("every token has a default in both themes", () => {
    for (const theme of Object.values(HTML_THEME_DEFAULTS))
      for (const name of Object.keys(HTML_THEME_TOKENS))
        expect(theme.variables[name]).toBeTruthy();
  });
});
