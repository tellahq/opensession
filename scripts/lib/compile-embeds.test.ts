import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  embedSpecifier,
  generateSimulatorViewerEmbedModule,
  withGeneratedModules,
  writeSimulatorViewerDist,
} from "./compile-embeds";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "compile-embeds-test-"));
  roots.push(root);
  return root;
}

test("viewer dist writes every served asset except the string shell", async () => {
  const root = await scratch();
  const dist = join(root, "dist");
  const files = new Map<string, Blob>([
    ["/", new Blob(["<!doctype html>"], { type: "text/html" })],
    ["/main.js", new Blob(["console.log(1)"])],
    ["/utilities.css", new Blob([".p{padding:0}"])],
  ]);
  expect(await writeSimulatorViewerDist(files, dist)).toEqual([
    "main.js",
    "utilities.css",
  ]);
  expect(await readFile(join(dist, "main.js"), "utf8")).toBe("console.log(1)");
  await expect(
    writeSimulatorViewerDist(new Map([["/nested/x.js", new Blob([])]]), dist),
  ).rejects.toThrow(/unexpected/);
});

test("embed manifest imports each built asset as a file and maps its served path", async () => {
  const root = await scratch();
  const dist = join(root, "dist");
  await mkdir(join(dist, "ignored-dir"), { recursive: true });
  for (const name of ["main.js", "main.css", "utilities.css", ".hidden"])
    await writeFile(join(dist, name), name);
  const modulePath = join(
    root,
    "packages/core/opensession-server/src/simulator-portal/embedded-viewer.ts",
  );
  const source = generateSimulatorViewerEmbedModule(dist, modulePath);
  expect(source).toContain("AUTO-GENERATED");
  expect(source).toContain(
    'import __v0 from "../../../../../dist/main.css" with { type: "file" };',
  );
  expect(source).toContain('"/main.js": __v1,');
  expect(source).toContain('"/utilities.css": __v2,');
  expect(source).toContain("export const EMBEDDED_SIMULATOR_VIEWER = {");
  expect(source).not.toContain(".hidden");
  expect(source).not.toContain("ignored-dir");
  expect(embedSpecifier(modulePath, join(root, "packages/x.js"))).toBe(
    "../../../../x.js",
  );
  expect(embedSpecifier(join(root, "a.ts"), join(root, "b.js"))).toBe("./b.js");
});

test("embed manifest refuses a viewer build missing a required asset", async () => {
  const root = await scratch();
  await writeFile(join(root, "main.js"), "");
  expect(() =>
    generateSimulatorViewerEmbedModule(root, join(root, "m.ts")),
  ).toThrow(/main\.css/);
});

test("generated modules are restored after the build, also when it fails", async () => {
  const root = await scratch();
  const first = join(root, "first.ts");
  const second = join(root, "second.ts");
  await writeFile(first, "export const A = null;\n");
  await writeFile(second, "export const B = null;\n");
  const modules = [
    { path: first, content: "export const A = 1;\n" },
    { path: second, content: "export const B = 2;\n" },
  ];
  const seen = await withGeneratedModules(modules, async () => [
    await readFile(first, "utf8"),
    await readFile(second, "utf8"),
  ]);
  expect(seen).toEqual(["export const A = 1;\n", "export const B = 2;\n"]);
  expect(await readFile(first, "utf8")).toBe("export const A = null;\n");
  expect(await readFile(second, "utf8")).toBe("export const B = null;\n");

  await expect(
    withGeneratedModules(modules, async () => {
      expect(await readFile(second, "utf8")).toBe("export const B = 2;\n");
      throw new Error("bun build --compile failed");
    }),
  ).rejects.toThrow("bun build --compile failed");
  expect(await readFile(first, "utf8")).toBe("export const A = null;\n");
  expect(await readFile(second, "utf8")).toBe("export const B = null;\n");
});
