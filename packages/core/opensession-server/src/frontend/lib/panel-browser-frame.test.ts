import { expect, test } from "bun:test";
import { panelBrowserFrame } from "./panel-browser-frame";

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
