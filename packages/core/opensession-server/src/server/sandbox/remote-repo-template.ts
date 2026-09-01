/**
 * Durable post-setup repo templates for remote sandbox providers.
 *
 * Daytona stores templates as provider snapshots, Box as named snapshots,
 * and Modal as Image ids returned by Sandbox.snapshotFilesystem(). This file owns only the
 * small local index that maps (provider, repo, runtime/create signature and
 * project preparation inputs) to the provider artifact. The artifact itself
 * is credential-free and durable; adapters replace it only when an input that
 * affects setup changes.
 */

import { createHash, randomUUID } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { writeJsonAtomic } from "../shared/atomic-write";
import {
  remoteWarmWorkspaceDir,
  runnerToolchainSignature,
  shellQuoteWord,
  type RemoteDriver,
} from "./adapters/bootstrap";
import { getSandboxConnection } from "./connections";
import { configuredRepos } from "../config";

export type RemoteTemplateProvider = "daytona" | "box" | "modal";

export interface RemoteRepoTemplate {
  provider: RemoteTemplateProvider;
  repoId: string;
  artifactId: string;
  signature: string;
  createdAt: string;
  /** Legacy informational field. Expiry no longer invalidates stopped storage. */
  expiresAt?: string;
  projectSignature?: string;
}

/** Ramp-style source-image cadence. Compute runs only while replacing an image. */
export const REMOTE_REPO_TEMPLATE_REFRESH_MS = 30 * 60 * 1_000;
/** Box counts every create, fork, and resume against a 150 starts/day quota.
 * Since session adoption fetches the current branch anyway, spending 48 of
 * those starts per repo/day only to shorten the git delta harms availability
 * more than it helps latency. Setup-input changes still invalidate instantly. */
export const BOX_REPO_TEMPLATE_REFRESH_MS = 6 * 60 * 60 * 1_000;
/** Provider storage backstop where an API requires a finite snapshot TTL. */
export const REMOTE_REPO_TEMPLATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export function remoteRepoTemplateNeedsRefresh(
  template: Pick<RemoteRepoTemplate, "provider" | "createdAt">,
  now = Date.now(),
): boolean {
  const refreshMs =
    template.provider === "box"
      ? BOX_REPO_TEMPLATE_REFRESH_MS
      : REMOTE_REPO_TEMPLATE_REFRESH_MS;
  return now - Date.parse(template.createdAt) >= refreshMs;
}

export function remoteRepoTemplateProofPath(repoId: string): string {
  return `/home/ubuntu/.opensession/repo-template-${clean(repoId)}.json`;
}

/** Fail closed before a provider snapshot is published, then write a nonce
 * into the filesystem. Certification restores a second sandbox and requires
 * the exact nonce, proving it used the artifact rather than merely repeating
 * setup in another cold sandbox. */
export async function sealRemoteRepoTemplate(
  driver: RemoteDriver,
  provider: RemoteTemplateProvider,
  repo: { id: string },
): Promise<string> {
  const warmDir = remoteWarmWorkspaceDir(repo.id);
  const origin = await driver.exec("git remote get-url origin", {
    cwd: warmDir,
  });
  if (origin.exitCode !== 0 || /https?:\/\/[^/\s]+@/i.test(origin.stdout)) {
    throw new Error(
      `refusing to snapshot ${repo.id}: clone authority was not scrubbed`,
    );
  }
  const dirty = await driver.exec(
    "git status --porcelain --untracked-files=no",
    {
      cwd: warmDir,
    },
  );
  if (dirty.exitCode !== 0 || dirty.stdout.trim()) {
    throw new Error(
      `refusing to snapshot ${repo.id}: setup changed tracked project files` +
        (dirty.stdout.trim()
          ? ` (${dirty.stdout.trim().split("\\n").slice(0, 5).join(", ")})`
          : ""),
    );
  }
  const sensitive = await driver.exec(
    "for f in " +
      [
        "/home/ubuntu/.claude/.credentials.json",
        "/home/ubuntu/.codex/auth.json",
        "/home/ubuntu/.config/pi/auth.json",
        "/home/ubuntu/.opensession-claude-accounts.json",
        "/home/ubuntu/.opensession-pi.json",
        "/home/ubuntu/.opensession-pi.json",
      ]
        .map(shellQuoteWord)
        .join(" ") +
      '; do [ ! -s "$f" ] || echo "$f"; done',
  );
  if (sensitive.exitCode !== 0 || sensitive.stdout.trim()) {
    throw new Error(
      `refusing to snapshot ${repo.id}: launch credentials are present (${sensitive.stdout.trim()})`,
    );
  }
  const nonce = randomUUID();
  const proof = JSON.stringify({
    provider,
    repoId: repo.id,
    signature: remoteRepoTemplateSignature(provider),
    projectSignature: projectPreparationSignature(repo.id),
    nonce,
    sealedAt: new Date().toISOString(),
  });
  const path = remoteRepoTemplateProofPath(repo.id);
  const written = await driver.exec(
    `mkdir -p ${shellQuoteWord(path.slice(0, path.lastIndexOf("/")))} && printf %s ${shellQuoteWord(proof)} > ${shellQuoteWord(path)}`,
  );
  if (written.exitCode !== 0) {
    throw new Error(
      `could not seal ${provider} repo template: ${written.stderr.trim()}`,
    );
  }
  return nonce;
}

export async function validateRemoteRepoTemplate(
  driver: RemoteDriver,
  provider: RemoteTemplateProvider,
  repo: { id: string },
): Promise<string> {
  const proof = await driver.exec(
    `cat ${shellQuoteWord(remoteRepoTemplateProofPath(repo.id))}`,
  );
  if (proof.exitCode !== 0) {
    throw new Error(`restored ${provider} template has no seal for ${repo.id}`);
  }
  let parsed: {
    provider?: string;
    repoId?: string;
    signature?: string;
    projectSignature?: string;
    nonce?: string;
  };
  try {
    parsed = JSON.parse(proof.stdout);
  } catch {
    throw new Error(
      `restored ${provider} template has a malformed seal for ${repo.id}`,
    );
  }
  if (
    parsed.provider !== provider ||
    parsed.repoId !== repo.id ||
    parsed.signature !== remoteRepoTemplateSignature(provider) ||
    parsed.projectSignature !== projectPreparationSignature(repo.id) ||
    !parsed.nonce
  ) {
    throw new Error(
      `restored ${provider} template seal does not match ${repo.id}`,
    );
  }
  const warm = await driver.exec(
    `test -d ${shellQuoteWord(remoteWarmWorkspaceDir(repo.id))}/.git && git remote get-url origin`,
    { cwd: remoteWarmWorkspaceDir(repo.id) },
  );
  if (warm.exitCode !== 0 || /https?:\/\/[^/\s]+@/i.test(warm.stdout)) {
    throw new Error(
      `restored ${provider} template is missing or retained clone authority`,
    );
  }
  return parsed.nonce;
}

function clean(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const DEFAULT_PREPARATION_INPUTS = [
  ".agents/setup",
  ".agents/sandbox-environment.json",
  "bun.lock",
] as const;

/** Repos declare EXTRA preparation inputs in their committed
 * `.agents/sandbox-environment.json` under `preparationInputs`: repo-relative
 * files or directories (extra lockfiles, patch dirs, toolchain pins) whose
 * committed content should rotate the prepared template. The declaration
 * lives in the repo so each project owns its own invalidation surface.
 * Exported for tests. */
export function parsePreparationInputs(raw: unknown): string[] {
  const list = (raw as { preparationInputs?: unknown } | null)
    ?.preparationInputs;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const path = entry.replace(/\/+$/, "");
    if (
      !path ||
      path.length > 200 ||
      path.startsWith("/") ||
      path.startsWith("-")
    )
      continue;
    if (/[\0\n:\\]/.test(path)) continue;
    if (
      path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
    )
      continue;
    if (!out.includes(path)) out.push(path);
    if (out.length >= 32) break;
  }
  return out;
}

/** The declared extras from the repo's committed environment file (never the
 * working tree when HEAD exists — same rule as the hashing below). Exported
 * for tests. */
export function declaredPreparationInputs(
  repoDir: string,
  hasHead: boolean,
): string[] {
  try {
    const raw = hasHead
      ? (() => {
          const shown = spawnSync(
            "git",
            ["-C", repoDir, "show", "HEAD:.agents/sandbox-environment.json"],
            { encoding: "utf-8", maxBuffer: 1024 * 1024 },
          );
          return shown.status === 0 ? shown.stdout : "";
        })()
      : readFileSync(
          join(repoDir, ".agents/sandbox-environment.json"),
          "utf-8",
        );
    if (!raw) return [];
    return parsePreparationInputs(JSON.parse(raw)).filter(
      (p) => !(DEFAULT_PREPARATION_INPUTS as readonly string[]).includes(p),
    );
  } catch {
    return [];
  }
}

/** Committed git object id (blob or tree — directories work too) for one
 * preparation input, so content addressing is git's own. */
function committedInputId(
  repoDir: string,
  relative: string,
  hasHead: boolean,
): string {
  if (hasHead) {
    const r = spawnSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "--quiet", `HEAD:${relative}`],
      { encoding: "utf-8" },
    );
    const oid = r.status === 0 ? r.stdout.trim() : "";
    return oid || "<absent>";
  }
  try {
    return createHash("sha256")
      .update(readFileSync(join(repoDir, relative)))
      .digest("hex");
  } catch {
    return "<absent>";
  }
}

/** Hash only committed content whose bytes affect the reusable prepared
 * filesystem: the defaults above plus whatever the repo itself declares.
 * Shared project images are built from repository commits, never from an
 * operator's dirty worktree. Reading working-tree bytes here made an
 * unrelated local bun.lock edit invalidate every provider artifact. */
export function projectPreparationSignature(repoId: string): string {
  const repo = configuredRepos()[repoId];
  const hash = createHash("sha256");
  hash.update(`project-preparation-v3\0${repoId}\0`);
  if (!repo) return hash.update("<unregistered>").digest("hex");
  const hasHead =
    spawnSync("git", ["-C", repo.repo, "rev-parse", "--verify", "HEAD"], {
      stdio: "ignore",
    }).status === 0;
  const inputs = [
    ...DEFAULT_PREPARATION_INPUTS,
    ...declaredPreparationInputs(repo.repo, hasHead),
  ];
  for (const relative of inputs) {
    hash.update(`${relative}\0`);
    hash.update(committedInputId(repo.repo, relative, hasHead));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function dir(): string {
  return `${process.env.OPENSESSION_SESSIONS_DIR || OPENSESSION_SESSIONS_DIR}/sandbox-repo-templates`;
}

function file(provider: RemoteTemplateProvider, repoId: string): string {
  return `${dir()}/${provider}-${clean(repoId)}.json`;
}

/** Includes every create-time input whose change makes an artifact unsafe to
 * reuse. Source freshness is handled by adoption's fetch; dependency/setup
 * freshness is handled separately by projectPreparationSignature; a runner
 * commit pin bump is deliberately NOT here — adoption's bootstrap reconciles
 * the pin inside the restored filesystem (see runnerToolchainSignature), so
 * templates survive ordinary deploys instead of rebuilding on every one. */
export function remoteRepoTemplateSignature(
  provider: RemoteTemplateProvider,
): string {
  const settings = getSandboxConnection(provider)?.settings || {};
  const shape =
    provider === "daytona"
      ? { baseSnapshot: settings.snapshot || "default" }
      : provider === "box"
        ? { machineProfile: settings.profile || "default" }
        : {
            image: settings.image || "daytonaio/sandbox:0.8.0",
            cpu: settings.cpu || null,
            memory: settings.memoryMb || null,
            region: settings.region || null,
            cloud: settings.cloud || null,
          };
  return createHash("sha256")
    .update(
      `repo-template-v3|${runnerToolchainSignature()}|${JSON.stringify(shape)}`,
    )
    .digest("hex");
}

/** Deterministic, provider-safe name used by Daytona and Box snapshot APIs. */
export function remoteRepoTemplateName(
  provider: RemoteTemplateProvider,
  repoId: string,
): string {
  const suffix = createHash("sha256")
    .update(
      `${remoteRepoTemplateSignature(provider)}|${projectPreparationSignature(repoId)}`,
    )
    .digest("hex")
    .slice(0, 16);
  return `opensession-${clean(repoId).slice(0, 36)}-${suffix}`;
}

export function readRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
  _now = Date.now(),
): RemoteRepoTemplate | null {
  try {
    const path = file(provider, repoId);
    if (!existsSync(path)) return null;
    const entry = JSON.parse(readFileSync(path, "utf-8")) as RemoteRepoTemplate;
    const projectSignature = projectPreparationSignature(repoId);
    if (
      entry.provider !== provider ||
      entry.repoId !== repoId ||
      !entry.artifactId ||
      entry.signature !== remoteRepoTemplateSignature(provider) ||
      (entry.projectSignature != null &&
        entry.projectSignature !== projectSignature)
    ) {
      try {
        unlinkSync(path);
      } catch {}
      return null;
    }
    if (!entry.projectSignature) {
      entry.projectSignature = projectSignature;
      writeJsonAtomic(path, entry);
    }
    return entry;
  } catch {
    return null;
  }
}

export function writeRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
  artifactId: string,
  now = Date.now(),
): { current: RemoteRepoTemplate; previous: RemoteRepoTemplate | null } {
  const path = file(provider, repoId);
  let previous: RemoteRepoTemplate | null = null;
  try {
    previous = JSON.parse(readFileSync(path, "utf-8")) as RemoteRepoTemplate;
  } catch {}
  const current: RemoteRepoTemplate = {
    provider,
    repoId,
    artifactId,
    signature: remoteRepoTemplateSignature(provider),
    projectSignature: projectPreparationSignature(repoId),
    createdAt: new Date(now).toISOString(),
  };
  mkdirSync(dir(), { recursive: true });
  writeJsonAtomic(path, current);
  return { current, previous };
}

export function invalidateRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
): RemoteRepoTemplate | null {
  const path = file(provider, repoId);
  let previous: RemoteRepoTemplate | null = null;
  try {
    previous = JSON.parse(readFileSync(path, "utf-8")) as RemoteRepoTemplate;
  } catch {}
  try {
    unlinkSync(path);
  } catch {}
  return previous;
}
