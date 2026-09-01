import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  parseAddedLines,
  runSecretScanCheck,
  secretScanSection,
} from "./secret-scan";

describe("parseAddedLines", () => {
  test("maps -U0 hunks to added new-file line numbers per file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,0 +11,2 @@ ctx",
      "+one",
      "+two",
      "@@ -20 +23 @@ ctx",
      "-old",
      "+new",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-x",
      "diff --git a/new.ts b/new.ts",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,3 @@",
      "+a",
      "+b",
      "+c",
    ].join("\n");
    const m = parseAddedLines(diff);
    expect([...(m.get("src/a.ts") || [])].sort((x, y) => x - y)).toEqual([
      11, 12, 23,
    ]);
    expect(m.has("gone.ts")).toBe(false);
    expect([...(m.get("new.ts") || [])].sort((x, y) => x - y)).toEqual([
      1, 2, 3,
    ]);
  });

  test("pure deletion hunks (+c,0) add no lines", () => {
    const diff = ["+++ b/d.ts", "@@ -5,2 +4,0 @@", "-a", "-b"].join("\n");
    expect(parseAddedLines(diff).has("d.ts")).toBe(false);
  });
});

/** Throwaway repo: base commit, then a head commit, with origin/main pointed at base. */
async function makeRepo(
  dir: string,
  headEdit: (dir: string) => void,
): Promise<void> {
  mkdirSync(join(dir, "src"), { recursive: true });
  await $`git -C ${dir} init -q -b main`.quiet();
  await $`git -C ${dir} config user.email t@t.t`.quiet();
  await $`git -C ${dir} config user.name t`.quiet();
  writeFileSync(join(dir, "src/creds.ts"), "l1\nl2\nl3\nl4\nl5\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -qm base`.quiet();
  const base = (await $`git -C ${dir} rev-parse HEAD`.quiet().text()).trim();
  headEdit(dir);
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -qm head`.quiet();
  await $`git -C ${dir} update-ref refs/remotes/origin/main ${base}`.quiet();
}

/** Fake scanner: emits one canned finding at the given line of src/creds.ts. */
function makeFakeScanner(dir: string, line: number): string {
  const bin = join(dir, "fake-trufflehog");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '{"DetectorName":"FakeDetector","Verified":true,"Redacted":"AKIA****","SourceMetadata":{"Data":{"Filesystem":{"file":"%s/src/creds.ts","line":${line}}}}}\\n' "$2"\n`,
    { mode: 0o755 },
  );
  return bin;
}

describe("runSecretScanCheck", () => {
  test("reports a finding on an added line and maps the path back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-test-"));
    try {
      await makeRepo(dir, (d) =>
        writeFileSync(join(d, "src/creds.ts"), "l1\nl2\nSECRET\nl4\nl5\n"),
      );
      const res = await runSecretScanCheck({
        cwd: dir,
        baseRefName: "main",
        prNumber: 1,
        bin: makeFakeScanner(dir, 3),
      });
      expect(res.skipped).toBe("");
      expect(res.findings).toEqual([
        {
          file: "src/creds.ts",
          line: 3,
          detector: "FakeDetector",
          redacted: "AKIA****",
          verified: true,
        },
      ]);
      expect(secretScanSection(res)).toContain("src/creds.ts:3");
      expect(secretScanSection(res)).toContain("verified live");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drops findings on lines the PR did not add", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-test-"));
    try {
      await makeRepo(dir, (d) =>
        writeFileSync(join(d, "src/creds.ts"), "l1\nl2\nchanged\nl4\nl5\n"),
      );
      const res = await runSecretScanCheck({
        cwd: dir,
        baseRefName: "main",
        prNumber: 1,
        bin: makeFakeScanner(dir, 5), // pre-existing line, not added by the PR
      });
      expect(res.skipped).toBe("");
      expect(res.findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips cleanly when the PR only deletes lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-test-"));
    try {
      await makeRepo(dir, (d) =>
        writeFileSync(join(d, "src/creds.ts"), "l1\nl2\nl4\nl5\n"),
      );
      // Deleting a line rewrites neighbors in -U0 terms only when content shifts;
      // a pure deletion of l3 yields a +3,0 hunk — no added lines.
      const res = await runSecretScanCheck({
        cwd: dir,
        baseRefName: "main",
        prNumber: 1,
        bin: makeFakeScanner(dir, 1),
      });
      expect(res.findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Real-binary plumbing test: a fake key must NOT report under the
  // verified,unknown policy, and the pipeline must complete without skipping.
  const realBin = join(homedir(), "bin", "trufflehog");
  test.if(existsSync(realBin))(
    "real trufflehog run completes and stays quiet on a fake key",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ss-test-"));
      try {
        await makeRepo(dir, (d) =>
          writeFileSync(
            join(d, "src/creds.ts"),
            "l1\nl2\nSTRIPE=sk_live_51AbCdEfGhIjKlMnOpQrStUvWxYz01234567\nl4\nl5\n",
          ),
        );
        const res = await runSecretScanCheck({
          cwd: dir,
          baseRefName: "main",
          prNumber: 1,
          bin: realBin,
        });
        expect(res.skipped).toBe("");
        expect(res.checkedFiles).toBe(1);
        expect(res.findings).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    200_000,
  );
});
