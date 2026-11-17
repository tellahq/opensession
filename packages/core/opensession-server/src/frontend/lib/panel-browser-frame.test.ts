import { describe, expect, test } from "bun:test";
import { panelBrowserFrame, summaryBrowserFrame } from "./panel-browser-frame";

const preview = { embeddable: true };

test("a link handed to the panel is its page", () => {
  const frame = panelBrowserFrame({
    sessionId: "s1",
    target: { kind: "url", url: "https://docs.example.test/" },
    staging: preview,
    stagingUrl: "https://pr.example.test/",
  });
  expect(frame?.key).toBe("panel:s1");
  expect(frame?.spec.url).toBe("https://docs.example.test/");
});

test("otherwise the PR preview, when it can be framed", () => {
  const input = {
    sessionId: "s1",
    target: null,
    stagingUrl: "https://pr.example.test/",
  };
  expect(panelBrowserFrame({ ...input, staging: preview })?.spec.url).toBe(
    "https://pr.example.test/",
  );
  expect(
    panelBrowserFrame({ ...input, staging: { embeddable: false } }),
  ).toBeNull();
  expect(
    panelBrowserFrame({ ...input, staging: preview, stagingUrl: null }),
  ).toBeNull();
});

describe("summaryBrowserFrame", () => {
  const base = {
    sessionId: "s1",
    target: null,
    staging: preview,
    stagingUrl: "https://pr.example.test/",
    showing: false,
    hasPanelTab: false,
    autoOpen: false,
    scope: "w1",
  };

  test("a side panel Browser tab is previewed while it is not showing", () => {
    const panel = { ...base, dock: "panel" as const, hasPanelTab: true };
    expect(summaryBrowserFrame(panel)?.key).toBe("panel:s1");
    expect(summaryBrowserFrame({ ...panel, showing: true })).toBeNull();
  });

  test("with auto-open on, a ready preview shows with no tab", () => {
    const panel = { ...base, dock: "panel" as const };
    expect(summaryBrowserFrame(panel)).toBeNull();
    expect(summaryBrowserFrame({ ...panel, autoOpen: true })?.key).toBe(
      "panel:s1",
    );
  });

  test("Browser in the main strip previews that strip's preview page", () => {
    const main = { ...base, dock: "main" as const, autoOpen: true };
    const frame = summaryBrowserFrame(main);
    expect(frame?.key).toBe("staging:w1");
    expect(frame?.spec.url).toBe("https://pr.example.test/");
    expect(summaryBrowserFrame({ ...main, showing: true })).toBeNull();
    expect(summaryBrowserFrame({ ...main, autoOpen: false })).toBeNull();
    expect(
      summaryBrowserFrame({ ...main, staging: { embeddable: false } }),
    ).toBeNull();
  });
});
