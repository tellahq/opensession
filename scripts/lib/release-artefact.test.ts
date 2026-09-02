/**
 * The compiled release must carry every template the service installer opens
 * from the release directory. v0.4.52 shipped without `opensession.socket`, so
 * `opensession service install` failed on every published Linux artefact
 * (tellahq/opensession#244). This scans `service.ts` for the literal paths it
 * resolves from REPO_ROOT / serviceWorkdir() and fails when one is neither
 * staged nor explicitly exempted with a reason.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  RELEASE_SERVICE_TEMPLATES,
  RELEASE_TEMPLATE_EXEMPTIONS,
} from "./release-artefact";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Every `join(REPO_ROOT | serviceWorkdir(), "a", "b")` literal in service.ts. */
function releaseDirPathsReadByServiceInstaller(): string[] {
  const source = readFileSync(join(import.meta.dir, "service.ts"), "utf8");
  const calls = source.matchAll(
    /join\(\s*(?:REPO_ROOT|serviceWorkdir\(\))\s*,((?:\s*"[^"]+"\s*,?)+)\s*\)/g,
  );
  const paths = new Set<string>();
  for (const match of calls) {
    const segments = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    paths.add(segments.join("/"));
  }
  return [...paths].sort();
}

describe("compiled release artefact", () => {
  test("service.ts resolves at least the known unit templates", () => {
    const paths = releaseDirPathsReadByServiceInstaller();
    // Guards the scanner itself: if the regex silently matched nothing the
    // staging assertion below would pass vacuously.
    expect(paths).toContain("opensession.service");
    expect(paths).toContain("opensession.socket");
    expect(paths).toContain("opensession-executor.service");
    expect(paths).toContain("opensession-session-kernel.service");
  });

  test("every template the service installer reads is staged or exempted", () => {
    const staged = new Set(RELEASE_SERVICE_TEMPLATES);
    const missing = releaseDirPathsReadByServiceInstaller().filter(
      (rel) => !staged.has(rel) && !RELEASE_TEMPLATE_EXEMPTIONS.has(rel),
    );
    expect(missing).toEqual([]);
  });

  test("the socket unit stays out of the compiled release", () => {
    // A compiled `opensession server` binds its port through Bun.serve and
    // never adopts a systemd fd, so a shipped socket unit only takes the port
    // away from it (tellahq/opensession#297). The installer skips it; the
    // artefact must not tempt anyone into copying it in by hand.
    expect(RELEASE_SERVICE_TEMPLATES).not.toContain("opensession.socket");
    expect(RELEASE_TEMPLATE_EXEMPTIONS.has("opensession.socket")).toBe(true);
  });

  test("every staged file exists in the checkout", () => {
    const absent = RELEASE_SERVICE_TEMPLATES.filter(
      (rel) => !existsSync(join(REPO_ROOT, rel)),
    );
    expect(absent).toEqual([]);
  });

  test("exemptions only cover paths service.ts still reads", () => {
    const read = new Set(releaseDirPathsReadByServiceInstaller());
    const stale = [...RELEASE_TEMPLATE_EXEMPTIONS.keys()].filter(
      (rel) => !read.has(rel),
    );
    expect(stale).toEqual([]);
  });
});
