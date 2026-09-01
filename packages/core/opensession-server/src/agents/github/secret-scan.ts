/**
 * Deterministic secret scan on the PR's added content (openclaw autoreview
 * style): TruffleHog with the low-false-positive `verified,unknown` results
 * policy — a credential that TruffleHog actively verified against its provider,
 * or couldn't definitively verify, blocks; a definitively-invalid match is
 * dropped. Unlike model judgment this has a real oracle, so it runs as a
 * sidecar next to the model review (like test-on-base) rather than as a prompt
 * instruction.
 *
 * TruffleHog's git source uses go-git, which chokes on linked worktrees (our
 * review checkouts), so instead of scanning the repo we snapshot the post-image
 * of every file the PR adds/modifies into a temp dir, scan that with the
 * filesystem source, and keep only findings that land on a line the PR ADDED
 * (per `git diff -U0`). That makes the claim precise — "this PR introduces this
 * credential" — and never blames a pre-existing secret in a touched file.
 *
 * Fails soft everywhere: no trufflehog binary, git errors, or a scan timeout
 * all return a skipped result and the review proceeds without the section.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { audit } from "../../server/audit";
import { runCommand } from "../../server/run-command";

export interface SecretFinding {
  /** Repo-relative path. */
  file: string;
  /** 1-based line in the PR's version of the file. */
  line: number;
  detector: string;
  /** TruffleHog's redacted form (safe to post; never the raw value). */
  redacted: string;
  verified: boolean;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  /** Changed files snapshotted and scanned. */
  checkedFiles: number;
  /** Non-empty when the scan didn't run, with the reason. */
  skipped: string;
}

const GIT_TIMEOUT_MS = 30_000;
const SCAN_TIMEOUT_MS = 180_000;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS = 20;

/**
 * Added-line numbers per new-file path from a `git diff -U0` patch.
 * Exported for tests.
 */
export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path === "/dev/null") {
        current = null;
      } else {
        const rel = path.startsWith("b/") ? path.slice(2) : path;
        current = byFile.get(rel) || new Set();
        byFile.set(rel, current);
      }
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = parseInt(hunk[1], 10);
      const count = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
      for (let i = 0; i < count; i++) current.add(start + i);
    }
  }
  for (const [file, lines] of byFile) if (!lines.size) byFile.delete(file);
  return byFile;
}

function trufflehogBin(): string | null {
  const onPath = Bun.which("trufflehog");
  if (onPath) return onPath;
  const home = join(homedir(), "bin", "trufflehog");
  return existsSync(home) ? home : null;
}

export async function runSecretScanCheck(opts: {
  /** Review worktree pinned to the PR head. */
  cwd: string;
  baseRefName: string;
  prNumber: number;
  ghRepo?: string;
  /** Test seam: scanner binary override. */
  bin?: string;
}): Promise<SecretScanResult> {
  const done = (result: SecretScanResult): SecretScanResult => {
    audit({
      msg: "review_secret_scan",
      pr_number: opts.prNumber,
      repo: opts.ghRepo,
      checked_files: result.checkedFiles,
      findings: result.findings.length,
      ...(result.skipped ? { skipped: result.skipped } : {}),
    });
    return result;
  };
  const skip = (reason: string) =>
    done({ findings: [], checkedFiles: 0, skipped: reason });

  const bin = opts.bin || trufflehogBin();
  if (!bin) return skip("trufflehog not installed");

  const mb = await runCommand(
    ["git", "merge-base", "HEAD", `origin/${opts.baseRefName}`],
    {
      cwd: opts.cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    },
  );
  const mergeBase = mb.stdout.trim();
  if (mb.status !== 0 || !mergeBase)
    return skip(`merge-base failed: ${mb.stderr.trim().slice(0, 200)}`);

  const diff = await runCommand(
    [
      "git",
      "diff",
      "-U0",
      "--no-color",
      "--find-renames",
      "--diff-filter=AM",
      mergeBase,
      "HEAD",
    ],
    { cwd: opts.cwd, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (diff.status !== 0)
    return skip(`diff failed: ${diff.stderr.trim().slice(0, 200)}`);
  const addedLines = parseAddedLines(diff.stdout);
  if (!addedLines.size) return skip("no added lines");

  // Snapshot the post-image of each changed file so the filesystem source scans
  // exactly the PR's content, keeping relative paths for mapping findings back.
  const snapDir = mkdtempSync(join(tmpdir(), "os-review-secrets-"));
  try {
    let copied = 0;
    for (const file of [...addedLines.keys()].slice(0, MAX_FILES)) {
      const src = join(opts.cwd, file);
      try {
        if (!existsSync(src) || statSync(src).size > MAX_FILE_BYTES) continue;
        mkdirSync(dirname(join(snapDir, file)), { recursive: true });
        copyFileSync(src, join(snapDir, file));
        copied++;
      } catch {}
    }
    if (!copied) return skip("no scannable changed files");

    const scan = await runCommand(
      [
        bin,
        "filesystem",
        snapDir,
        "--results=verified,unknown",
        "--json",
        "--no-update",
      ],
      { timeoutMs: SCAN_TIMEOUT_MS },
    );
    // TruffleHog exits non-zero with --fail on hits; without it, non-zero means
    // the scan itself broke.
    if (scan.status !== 0)
      return skip(
        `trufflehog exited ${scan.status}: ${scan.stderr.trim().slice(0, 200)}`,
      );

    const findings: SecretFinding[] = [];
    const seen = new Set<string>();
    for (const line of scan.stdout.split("\n")) {
      if (!line.trim()) continue;
      let f: any;
      try {
        f = JSON.parse(line);
      } catch {
        continue;
      }
      const meta = f?.SourceMetadata?.Data?.Filesystem;
      if (!meta?.file) continue;
      const rel = String(meta.file).startsWith(snapDir + "/")
        ? String(meta.file).slice(snapDir.length + 1)
        : String(meta.file);
      const lineNo = typeof meta.line === "number" ? meta.line : 0;
      // Only lines this PR added — a hit elsewhere in a touched file is a
      // pre-existing secret, not this PR's introduction.
      if (!lineNo || !addedLines.get(rel)?.has(lineNo)) continue;
      const key = `${rel}:${lineNo}:${f.DetectorName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        file: rel,
        line: lineNo,
        detector: String(f.DetectorName || "unknown"),
        redacted: String(f.Redacted || "").slice(0, 80),
        verified: !!f.Verified,
      });
      if (findings.length >= MAX_FINDINGS) break;
    }
    return done({ findings, checkedFiles: copied, skipped: "" });
  } finally {
    rmSync(snapDir, { recursive: true, force: true });
  }
}

/** Summary-comment section for a scan that found secrets ("" when clean/skipped). */
export function secretScanSection(result: SecretScanResult | null): string {
  if (!result || result.skipped || !result.findings.length) return "";
  const rows = result.findings
    .map(
      (f) =>
        `- \`${f.file}:${f.line}\` — ${f.detector}${f.redacted ? ` (\`${f.redacted}\`)` : ""}${f.verified ? " — **verified live**" : ""}`,
    )
    .join("\n");
  return [
    `\n\n🚨 **Secret scan** — TruffleHog flagged ${result.findings.length} credential${result.findings.length === 1 ? "" : "s"} introduced on lines this PR adds:`,
    rows,
    "_Treat these as leaked: rotate the credential now, then remove it from the branch (a follow-up commit that deletes the line does NOT un-leak it from git history). (Deterministic check: TruffleHog `verified,unknown` policy over the PR's added lines.)_",
  ].join("\n");
}
