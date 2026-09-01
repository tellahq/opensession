import { expect, test } from "bun:test";
import {
  builtAssetContentType,
  handleStaticAssetsRoutes,
  pwaManifest,
} from "./static-assets";

test("serves every stable shell asset family", async () => {
  for (const [path, contentType] of [
    ["/mac-app-icon.png", "image/png"],
    ["/icon.png", "image/png"],
    // Compatibility URL serves the new fixed artwork to older app bundles.
    ["/signin-bg.webp", "image/webp"],
    ["/onboarding-bg.webp", "image/webp"],
    ["/onboarding-bg-dark.webp", "image/webp"],
    ["/download-background.webp", "image/webp"],
    ["/download-background-dark.webp", "image/webp"],
    ["/download-mac.webp", "image/webp"],
    ["/download-phone.webp", "image/webp"],
    ["/sw.js", "text/javascript; charset=utf-8"],
    ["/splash/apple-splash-1206-2622.png", "image/png"],
  ] as const) {
    const url = new URL(`http://127.0.0.1${path}`);
    const response = await handleStaticAssetsRoutes({
      req: new Request(url),
      url,
      path,
      publicPrefix: "",
    });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe(contentType);
    expect((await response?.arrayBuffer())?.byteLength).toBeGreaterThan(0);
  }
});

test("returns a real 404 for a retired hashed asset", async () => {
  const path = "/Settings-retired123.js";
  const url = new URL(`http://127.0.0.1${path}`);
  const response = await handleStaticAssetsRoutes({
    req: new Request(url),
    url,
    path,
    publicPrefix: "",
  });
  expect(response?.status).toBe(404);
  expect(response?.headers.get("content-type")).toStartWith("text/plain");
});

test("recognizes bundled image assets alongside scripts and styles", () => {
  expect(builtAssetContentType("download-mac-abc123.webp")).toBe("image/webp");
  expect(builtAssetContentType("App-abc123.js")).toBe("text/javascript");
  expect(builtAssetContentType("notes.txt")).toBeNull();
});

test("PWA manifest includes a new-agent shortcut under the active prefix", () => {
  const manifest = pwaManifest("/backstage");
  expect(manifest.background_color).toBe("#1c1c1c");
  expect(manifest.theme_color).toBe("#222222");
  expect(manifest.shortcuts).toEqual([
    {
      name: "Start an agent",
      url: "/backstage/new",
      icons: [
        {
          src: "/backstage/icon-192.png?v=5",
          sizes: "192x192",
          type: "image/png",
        },
      ],
    },
  ]);
});
