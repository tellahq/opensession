import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  baseRuntimeMarkerCheck,
  baseRuntimeSignature,
  bunCacheEmptyBinsScript,
  remoteLayout,
} from "./bootstrap";

const root = mkdtempSync(join(tmpdir(), "opensession-runtime-checks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(script: string): string {
  const run = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe" });
  return run.stdout.toString().trim();
}

test("the base runtime marker counts only while the pinned Node is installed", () => {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const L = remoteLayout("darwin", home);
  writeFileSync(
    join(home, ".opensession-base-runtime"),
    baseRuntimeSignature(),
  );
  const check = baseRuntimeMarkerCheck(L);
  // A home restored over a fresh base image keeps the marker but not
  // /usr/local: the check must look at the binary, not only the marker.
  expect(check).toContain("/usr/local/bin/node");
  expect(check.indexOf("/usr/local/bin/node")).toBeLessThan(
    check.indexOf(".opensession-base-runtime"),
  );
  const pinned = baseRuntimeSignature().match(/node@([^+]+)/)?.[1];
  const installed = sh(
    "/usr/local/bin/node -p 'process.versions.node' 2>/dev/null",
  );
  const tools = sh(
    `PATH='${L.path}' command -v just >/dev/null && PATH='${L.path}' command -v gh >/dev/null && echo ok`,
  );
  expect(sh(check)).toBe(
    installed === pinned && tools === "ok" ? baseRuntimeSignature() : "",
  );
});

test("finds cached packages whose executables are gone", () => {
  const home = join(root, "cache-home");
  const cache = join(home, ".bun/install/cache");
  mkdirSync(join(cache, "esbuild@0.28.2@@@1/bin"), { recursive: true });
  mkdirSync(join(cache, "@esbuild/linux-x64@0.28.2@@@1/bin"), {
    recursive: true,
  });
  mkdirSync(join(cache, "acorn@8.14.0@@@1/bin"), { recursive: true });
  writeFileSync(join(cache, "acorn@8.14.0@@@1/bin/acorn"), "#!/bin/sh\n");
  const found = sh(bunCacheEmptyBinsScript(remoteLayout("darwin", home)))
    .split("\n")
    .sort();
  expect(found).toEqual([
    `${cache}/@esbuild/linux-x64@0.28.2@@@1/bin`,
    `${cache}/esbuild@0.28.2@@@1/bin`,
  ]);
  // No cache at all is not damage.
  expect(
    sh(bunCacheEmptyBinsScript(remoteLayout("darwin", join(root, "none")))),
  ).toBe("");
});
