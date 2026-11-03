/**
 * Durable post-setup repo templates for remote sandbox providers.
 *
 * Daytona stores templates as provider snapshots, Box as named snapshots,
 * Tart as local VM clones, and use.computer as service snapshots. This file
 * owns only the small local index that maps (provider, repo, runtime/create signature and
 * project preparation inputs) to the provider artifact. The artifact itself
 * is credential-free and durable; adapters replace it only when an input that
 * affects setup changes.
 */

import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, unlink } from "fs/promises";
import { join } from "path";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { writeJsonAtomicAsync } from "../shared/atomic-write";
import {
  REMOTE_HOME,
  remoteLayoutForProvider,
  remoteWarmWorkspaceDir,
  baseRuntimeSignature,
  shellQuoteWord,
  type RemoteDriver,
} from "./adapters/bootstrap";
import { getSandboxConnection } from "./connections";
import { configuredRepos } from "../config";
import { repoPreSetupScript } from "./config";
import { MODAL_BASE_IMAGE_REVISION } from "./adapters/modal-image";

export type RemoteTemplateProvider =
  | "daytona"
  | "box"
  | "tart"
  | "usecomputer"
  | "modal";

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
/** Box counts every create, fork, and resume against a 150 starts/day quota,
 * so it refreshes less often than the 30-minute cadence. Not much less: the
 * image carries setup's generated output (for tella-fusion a ReScript build
 * of ~1,800 modules), and an image a working day behind the branch turns the
 * first Portal start into a multi-minute rebuild on a lazily restored disk.
 * Every two hours is 12 refreshes per repository a day. Setup-input changes
 * still invalidate instantly. */
export const BOX_REPO_TEMPLATE_REFRESH_MS = 2 * 60 * 60 * 1_000;

/** Whether a due refresh waits for the parked standby to be used first.
 * Daytona: yes, replacing it seals and restores a large snapshot and leaves
 * no standby meanwhile. Box: no, a standby is parked nearly all the time, so
 * waiting would stop the image from ever refreshing; the replacement becomes
 * the new standby. */
export function refreshWaitsForParkedStandby(
  provider: RemoteTemplateProvider,
): boolean {
  return provider !== "box";
}
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

export function remoteRepoTemplateProofPath(
  repoId: string,
  /** The guest user's home (the provider's layout). */
  home: string = REMOTE_HOME,
): string {
  return `${home}/.opensession/repo-template-${clean(repoId)}.json`;
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
  const L = remoteLayoutForProvider(provider);
  const home = L.home;
  const warmDir = remoteWarmWorkspaceDir(repo.id, L);
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
        `${home}/.claude/.credentials.json`,
        `${home}/.codex/auth.json`,
        `${home}/.config/pi/auth.json`,
        `${home}/.opensession-claude-accounts.json`,
        `${home}/.opensession-codex-accounts.json`,
        `${home}/.opensession-xai-accounts.json`,
        `${home}/.opensession-pi.json`,
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
    projectSignature: await projectPreparationSignature(repo.id),
    nonce,
    sealedAt: new Date().toISOString(),
  });
  const path = remoteRepoTemplateProofPath(repo.id, home);
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
  const L = remoteLayoutForProvider(provider);
  const proof = await driver.exec(
    `cat ${shellQuoteWord(remoteRepoTemplateProofPath(repo.id, L.home))}`,
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
    parsed.projectSignature !== (await projectPreparationSignature(repo.id)) ||
    !parsed.nonce
  ) {
    throw new Error(
      `restored ${provider} template seal does not match ${repo.id}`,
    );
  }
  const warm = await driver.exec(
    `test -d ${shellQuoteWord(remoteWarmWorkspaceDir(repo.id, L))}/.git && git remote get-url origin`,
    { cwd: remoteWarmWorkspaceDir(repo.id, L) },
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
export async function declaredPreparationInputs(
  repoDir: string,
  hasHead: boolean,
): Promise<string[]> {
  try {
    const raw = hasHead
      ? await (async () => {
          const shown = await git([
            "-C",
            repoDir,
            "show",
            "HEAD:.agents/sandbox-environment.json",
          ]);
          return shown.status === 0 ? shown.stdout : "";
        })()
      : await readFile(
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

/** Content hash for one preparation input of a repo with no commits yet (a
 * repo with HEAD uses git's own object id, see computePreparationSignature). */
async function uncommittedInputId(
  repoDir: string,
  relative: string,
): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(join(repoDir, relative)))
      .digest("hex");
  } catch {
    return "<absent>";
  }
}

type GitResult = { status: number | null; stdout: string };

async function git(args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, status] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { status, stdout };
}

/** The signature computation, off the gateway thread: a handful of git
 *  queries against the registered checkout. */
async function computePreparationSignature(repoId: string): Promise<string> {
  const repo = configuredRepos()[repoId];
  const hash = createHash("sha256");
  hash.update(`project-preparation-v3\0${repoId}\0`);
  if (!repo) return hash.update("<unregistered>").digest("hex");
  const hasHead =
    (await git(["-C", repo.repo, "rev-parse", "--verify", "HEAD"])).status ===
    0;
  let declared: string[] = [];
  if (hasHead) {
    const shown = await git([
      "-C",
      repo.repo,
      "show",
      "HEAD:.agents/sandbox-environment.json",
    ]);
    try {
      declared =
        shown.status === 0 && shown.stdout
          ? parsePreparationInputs(JSON.parse(shown.stdout)).filter(
              (p) =>
                !(DEFAULT_PREPARATION_INPUTS as readonly string[]).includes(p),
            )
          : [];
    } catch {
      declared = [];
    }
  } else {
    declared = await declaredPreparationInputs(repo.repo, false);
  }
  for (const relative of [...DEFAULT_PREPARATION_INPUTS, ...declared]) {
    hash.update(`${relative}\0`);
    if (hasHead) {
      const r = await git([
        "-C",
        repo.repo,
        "rev-parse",
        "--verify",
        "--quiet",
        `HEAD:${relative}`,
      ]);
      hash.update((r.status === 0 && r.stdout.trim()) || "<absent>");
    } else {
      hash.update(await uncommittedInputId(repo.repo, relative));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Signatures are read on every prewarm claim, template lookup and sweep. Each
 *  computation runs about seven git processes, so results are memoized; the
 *  sweep refreshes them in the background (every minute, inside this TTL).
 *  A cold or expired entry is computed once, shared by concurrent callers. */
const SIGNATURE_TTL_MS = 90_000;
const signatureCache = new Map<string, { at: number; value: string }>();
const signatureInflight = new Map<string, Promise<string>>();
let signatureGeneration = 0;

/** Hash only committed content whose bytes affect the reusable prepared
 * filesystem: the defaults above plus whatever the repo itself declares.
 * Shared project images are built from repository commits, never from an
 * operator's dirty worktree. Reading working-tree bytes here made an
 * unrelated local bun.lock edit invalidate every provider artifact. */
export async function projectPreparationSignature(
  repoId: string,
): Promise<string> {
  const hit = signatureCache.get(repoId);
  if (hit && Date.now() - hit.at < SIGNATURE_TTL_MS) return hit.value;
  return refreshProjectPreparationSignature(repoId);
}

/** A settings-held pre-setup script (Workspace → Sandboxes → Projects) is a
 *  setup input like `.agents/setup`. Folded in only when there is one, so a
 *  project without it keeps the signature, and the snapshot, it had. */
export function withPreSetupScript(repoId: string, signature: string): string {
  const script = repoPreSetupScript(repoId);
  if (!script) return signature;
  return createHash("sha256")
    .update(`${signature}|pre-setup:`)
    .update(script)
    .digest("hex");
}

/** Drop one repo's memoized signature (its pre-setup script changed). */
export function forgetProjectPreparationSignature(repoId: string): void {
  signatureCache.delete(repoId);
  signatureInflight.delete(repoId);
  signatureGeneration++;
}

/** Recompute a repo's signature without blocking the event loop, so later
 *  reads hit a fresh cache entry. Concurrent calls share one computation. */
export function refreshProjectPreparationSignature(
  repoId: string,
): Promise<string> {
  const inflight = signatureInflight.get(repoId);
  if (inflight) return inflight;
  const generation = signatureGeneration;
  const run = computePreparationSignature(repoId)
    .then((signature) => {
      const value = withPreSetupScript(repoId, signature);
      // A forget during the computation means its inputs changed: the
      // result is still this caller's answer but must not be memoized.
      if (generation === signatureGeneration)
        signatureCache.set(repoId, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      if (signatureInflight.get(repoId) === run)
        signatureInflight.delete(repoId);
    });
  signatureInflight.set(repoId, run);
  return run;
}

/** Refresh every signature something has asked for, off the event loop. */
export async function refreshCachedProjectPreparationSignatures(): Promise<void> {
  for (const repoId of [...signatureCache.keys()]) {
    await refreshProjectPreparationSignature(repoId).catch((e) =>
      console.warn(`[sandbox] preparation signature for ${repoId} failed:`, e),
    );
  }
}

/** Test-only: drop memoized signatures after a fixture commit. */
export function resetProjectPreparationSignaturesForTests(): void {
  signatureCache.clear();
  signatureInflight.clear();
  signatureGeneration++;
}

function dir(): string {
  return `${process.env.OPENSESSION_SESSIONS_DIR || OPENSESSION_SESSIONS_DIR}/sandbox-repo-templates`;
}

function file(provider: RemoteTemplateProvider, repoId: string): string {
  return `${dir()}/${provider}-${clean(repoId)}.json`;
}

/** Includes every create-time input whose change makes an artifact unsafe to
 * reuse. Source freshness is handled by adoption's fetch; dependency/setup
 * freshness is handled separately by projectPreparationSignature. The only
 * runtime a Sandbox carries is the base runtime, which names no Open Session
 * commit, so templates survive every ordinary deploy. */
export function remoteRepoTemplateSignature(
  provider: RemoteTemplateProvider,
): string {
  const settings = getSandboxConnection(provider)?.settings || {};
  const shape =
    provider === "daytona"
      ? { baseSnapshot: settings.snapshot || "default" }
      : provider === "tart"
        ? // Template VMs live on whichever Mac sealed them; the name stays the
          // same across hosts so a host list edit does not orphan them.
          { image: settings.image || "default" }
        : provider === "usecomputer"
          ? // Snapshots must match the reservation's VM layout; the service
            // picks the image.
            { reservation: settings.reservation || "default" }
          : provider === "modal"
            ? // Built on the base image; a new base retires it.
              {
                image: `${settings.image || "default"}|${MODAL_BASE_IMAGE_REVISION}`,
              }
            : { machineProfile: settings.profile || "default" };
  return createHash("sha256")
    .update(
      `repo-template-v4|${baseRuntimeSignature()}|${JSON.stringify(shape)}`,
    )
    .digest("hex");
}

/** Deterministic, provider-safe name used by Daytona and Box snapshot APIs. */
export async function remoteRepoTemplateName(
  provider: RemoteTemplateProvider,
  repoId: string,
): Promise<string> {
  const projectSignature = await projectPreparationSignature(repoId);
  const suffix = createHash("sha256")
    .update(`${remoteRepoTemplateSignature(provider)}|${projectSignature}`)
    .digest("hex")
    .slice(0, 16);
  return `opensession-${clean(repoId).slice(0, 36)}-${suffix}`;
}

export async function readRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
  _now = Date.now(),
): Promise<RemoteRepoTemplate | null> {
  try {
    const path = file(provider, repoId);
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch {
      return null;
    }
    const entry = JSON.parse(text) as RemoteRepoTemplate;
    const projectSignature = await projectPreparationSignature(repoId);
    if (
      entry.provider !== provider ||
      entry.repoId !== repoId ||
      !entry.artifactId ||
      entry.signature !== remoteRepoTemplateSignature(provider) ||
      (entry.projectSignature != null &&
        entry.projectSignature !== projectSignature)
    ) {
      // Keep the stale record on disk. It is never selected again, but the
      // next publish or invalidation reads it back as `previous` so the
      // provider artifact it names gets deleted. Unlinking it here leaked one
      // multi-gigabyte Box snapshot per toolchain change until the account
      // hit Box's named-snapshot cap.
      return null;
    }
    if (!entry.projectSignature) {
      entry.projectSignature = projectSignature;
      await writeJsonAtomicAsync(path, entry);
    }
    return entry;
  } catch {
    return null;
  }
}

export async function writeRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
  artifactId: string,
  now = Date.now(),
): Promise<{
  current: RemoteRepoTemplate;
  previous: RemoteRepoTemplate | null;
}> {
  const path = file(provider, repoId);
  const projectSignature = await projectPreparationSignature(repoId);
  let previous: RemoteRepoTemplate | null = null;
  try {
    previous = JSON.parse(await readFile(path, "utf-8")) as RemoteRepoTemplate;
  } catch {}
  const current: RemoteRepoTemplate = {
    provider,
    repoId,
    artifactId,
    signature: remoteRepoTemplateSignature(provider),
    projectSignature,
    createdAt: new Date(now).toISOString(),
  };
  await mkdir(dir(), { recursive: true });
  await writeJsonAtomicAsync(path, current);
  return { current, previous };
}

export async function invalidateRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
): Promise<RemoteRepoTemplate | null> {
  const path = file(provider, repoId);
  let previous: RemoteRepoTemplate | null = null;
  try {
    previous = JSON.parse(await readFile(path, "utf-8")) as RemoteRepoTemplate;
  } catch {}
  await unlink(path).catch(() => {});
  return previous;
}
