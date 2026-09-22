import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIMULATOR_VIEWER_INDEX_HTML,
  buildSimulatorViewer,
  buildSimulatorViewerFromSource,
  embeddedSimulatorViewerAssets,
  tailwindArgv,
  viewerContentType,
} from "./assets";

const execPath = process.execPath;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "execPath", { value: execPath });
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function pretendCompiled() {
  Object.defineProperty(process, "execPath", {
    value: "/opt/acme/opensession",
    configurable: true,
    writable: true,
  });
}

test("embedded viewer assets serve typed files behind the string shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "simulator-viewer-assets-"));
  roots.push(root);
  await writeFile(join(root, "main.js"), "console.log('viewer')");
  await writeFile(join(root, "main.css"), "body{margin:0}");
  await writeFile(join(root, "utilities.css"), ".p-1{padding:1px}");
  const files = embeddedSimulatorViewerAssets({
    assets: {
      "/main.js": join(root, "main.js"),
      "/main.css": join(root, "main.css"),
      "/utilities.css": join(root, "utilities.css"),
    },
  });
  expect([...files.keys()].sort()).toEqual([
    "/",
    "/main.css",
    "/main.js",
    "/utilities.css",
  ]);
  expect(files.get("/")?.type).toBe("text/html;charset=utf-8");
  expect(await files.get("/")?.text()).toBe(SIMULATOR_VIEWER_INDEX_HTML);
  expect(files.get("/main.js")?.type).toBe("text/javascript;charset=utf-8");
  expect(files.get("/main.css")?.type).toBe("text/css;charset=utf-8");
  expect(await files.get("/utilities.css")?.text()).toBe(".p-1{padding:1px}");
  expect(new Response(files.get("/main.js")).headers.get("content-type")).toBe(
    "text/javascript;charset=utf-8",
  );
  expect(() =>
    embeddedSimulatorViewerAssets({ assets: { "main.js": "/x" } }),
  ).toThrow(/Invalid/);
  expect(() =>
    embeddedSimulatorViewerAssets({ assets: { "/": "/x" } }),
  ).toThrow(/Invalid/);
});

test("viewer content types cover the served extensions", () => {
  expect(viewerContentType("/main.js")).toBe("text/javascript;charset=utf-8");
  expect(viewerContentType("/main.css")).toBe("text/css;charset=utf-8");
  expect(viewerContentType("/main.js.map")).toBe(
    "application/json;charset=utf-8",
  );
  expect(viewerContentType("/font.woff2")).toBe("font/woff2");
  expect(viewerContentType("/unknown.bin")).toBe("application/octet-stream");
});

test("the Tailwind CLI runs under the current Bun runtime, not the node shebang", () => {
  const argv = tailwindArgv("/repo", "/repo/src/tailwind.css");
  expect(argv).toEqual([
    process.execPath,
    "/repo/node_modules/.bin/tailwindcss",
    "-i",
    "/repo/src/tailwind.css",
    "--minify",
  ]);
});

test("a compiled binary without an embedded viewer fails clearly instead of bundling", async () => {
  pretendCompiled();
  await expect(buildSimulatorViewer()).rejects.toThrow(
    /no embedded simulator viewer/,
  );
});

test("source installs bundle the viewer without node on PATH", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent-acme-bin";
  try {
    const files = await buildSimulatorViewerFromSource();
    expect([...files.keys()]).toEqual(
      expect.arrayContaining(["/", "/main.js", "/main.css", "/utilities.css"]),
    );
    expect(files.get("/main.js")?.type).toBe("text/javascript;charset=utf-8");
    expect(files.get("/main.css")?.type).toBe("text/css;charset=utf-8");
    expect(files.get("/utilities.css")?.type).toBe("text/css;charset=utf-8");
    expect((await files.get("/main.js")?.text())?.length).toBeGreaterThan(1000);
    expect(await files.get("/utilities.css")?.text()).toContain("tailwindcss");
    const viaSource = await buildSimulatorViewer();
    expect([...viaSource.keys()].sort()).toEqual([...files.keys()].sort());
  } finally {
    process.env.PATH = path;
  }
}, 60_000);
