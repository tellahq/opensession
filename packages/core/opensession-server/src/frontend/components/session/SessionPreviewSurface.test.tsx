import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPreviewSurface } from "./SessionPreviewSurface";

const STAGING_URL = "https://preview.example.test/path?record=1";
const shareLink = () => {};

test("an embeddable staging deployment keeps its framed preview controls", () => {
  const html = renderToStaticMarkup(
    <SessionPreviewSurface
      surface={{
        kind: "staging",
        deployment: { status: "Building", embeddable: true },
        url: STAGING_URL,
        shareLink,
      }}
    />,
  );

  expect(html).toContain("Preview environment · building…");
  expect(html).toContain(`<iframe src="${STAGING_URL.replace("&", "&amp;")}"`);
  expect(html).toContain(
    'allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write"',
  );
  expect(html).toContain("Copy link");
  expect(html).toContain(">Open<");
});

test("a non-embeddable deployment keeps the first-party fallback", () => {
  const html = renderToStaticMarkup(
    <SessionPreviewSurface
      surface={{
        kind: "staging",
        deployment: { status: "Ready" },
        url: STAGING_URL,
        shareLink,
      }}
    />,
  );

  expect(html).not.toContain("<iframe");
  expect(html).toContain("Test this PR on real infra");
  expect(html).toContain("Open staging");
  expect(html).toContain("Copy link");
  expect(html).toContain(`href="${STAGING_URL.replace("&", "&amp;")}"`);
});

test("SessionViewer keeps preview selection and state ownership", async () => {
  const viewer = await Bun.file(
    new URL("../SessionViewer.tsx", import.meta.url),
  ).text();
  const branch = viewer.slice(
    viewer.indexOf("{showPortal && portalTarget ? ("),
    viewer.indexOf(") : showAssets ? ("),
  );
  const portal = branch.indexOf('kind: "portal"');
  const preview = branch.indexOf('kind: "preview"');
  const staging = branch.indexOf('kind: "staging"');

  expect(branch).toContain("<SessionPreviewSurface");
  expect(portal).toBeGreaterThan(-1);
  expect(preview).toBeGreaterThan(portal);
  expect(staging).toBeGreaterThan(preview);
  expect(branch).toContain("deployment: staging");
  expect(branch).toContain("url: stagingUrl");
  expect(branch).toContain("shareLink,");
});
