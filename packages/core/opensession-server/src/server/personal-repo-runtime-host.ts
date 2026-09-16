import { isPersonalCredentialKind } from "./personal-github/repository-coordinator";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertPersonalHostMcpNone } from "./personal-repo-runtime-mcp";
import type { RunHostSpec } from "../runner-host/protocol";
import type { Repo } from "./config";
import {
  PersonalRepoRuntimeError,
  samePersonalRepoBinding,
  type PersonalRepoBinding,
} from "./personal-repo-runtime";
import { personalRepoRuntime } from "./personal-repo-runtime-default";
import type { PersonalCredentialKind } from "./personal-github/repository-coordinator";

export const PERSONAL_HOST_AUTH_FILE = "personal-github-auth.json";
export interface PersonalHostProjection {
  version: 1;
  hostId: string;
  osSessionId: string;
  specHash: string;
  cwd: string;
  binding: PersonalRepoBinding;
  repo: Readonly<Repo>;
  kind: PersonalCredentialKind;
  /** One-use startup deadline, not the lifetime of an admitted run. */
  admitUntil: number;
  /** Actual installation credential expiry; legacy null values are rejected. */
  expiresAt: number | null;
  env: Record<string, string>;
}
let adopted: PersonalHostProjection | undefined;
function assertInstallationProjection(
  record: PersonalHostProjection,
  now = Date.now(),
): void {
  if (
    !isPersonalCredentialKind(record.kind) ||
    record.expiresAt === null ||
    !Number.isFinite(record.expiresAt) ||
    record.expiresAt <= now
  )
    throw new PersonalRepoRuntimeError();
}
async function plainDirectory(path: string) {
  let cursor = resolve(path);
  while (true) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new PersonalRepoRuntimeError();
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
export function assertPersonalHostLineage(
  spec: Pick<RunHostSpec, "personalRepo" | "logicalRunId">,
): void {
  if (
    spec.personalRepo &&
    (typeof spec.logicalRunId !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(spec.logicalRunId))
  )
    throw new PersonalRepoRuntimeError();
}

/** Gateway-only, freshly validates every local launch and respawn. */
export async function preparePersonalHostProjection(
  spec: RunHostSpec,
  dir: string,
  specHash: string,
) {
  if (!spec.personalRepo) return;
  assertPersonalHostLineage(spec);
  assertPersonalHostMcpNone(spec);
  const runtime = await personalRepoRuntime();
  const b = spec.personalRepo;
  const { personalHostCredentialKindAsync } =
    await import("./personal-repo-runtime-policy");
  const projected = await runtime.projectWorkspaceCredential(
    b.descriptor.ownerGithubAccountId,
    b,
    await personalHostCredentialKindAsync(spec),
    { sessionId: spec.osSessionId, cwd: spec.cwd },
  );
  const record: PersonalHostProjection = {
    version: 1,
    hostId: spec.hostId,
    osSessionId: spec.osSessionId,
    specHash,
    cwd: spec.cwd,
    binding: projected.binding,
    repo: projected.repo,
    kind: projected.kind,
    admitUntil: Date.now() + 300_000,
    expiresAt: projected.expiresAt,
    env: projected.env,
  };
  await writePersonalHostProjection(dir, record);
}
export async function writePersonalHostProjection(
  dir: string,
  record: PersonalHostProjection,
) {
  assertInstallationProjection(record);
  await plainDirectory(dir);
  const target = join(dir, PERSONAL_HOST_AUTH_FILE);
  try {
    await lstat(target);
    throw new PersonalRepoRuntimeError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = join(dir, `.personal-auth-${randomUUID()}`);
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temp, target); // atomic publication, refuses a concurrently created target
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function validatePersonalHostProjection(
  spec: RunHostSpec,
  hash: string,
  record: PersonalHostProjection,
  now = Date.now(),
) {
  assertPersonalHostLineage(spec);
  assertPersonalHostMcpNone(spec);
  assertInstallationProjection(record, now);
  if (
    !spec.personalRepo ||
    record.version !== 1 ||
    record.hostId !== spec.hostId ||
    record.osSessionId !== spec.osSessionId ||
    record.specHash !== hash ||
    record.cwd !== spec.cwd ||
    !samePersonalRepoBinding(record.binding, spec.personalRepo) ||
    record.kind !==
      (await import("./personal-repo-runtime-kind")).personalHostCredentialKind(
        spec,
      ) ||
    !Number.isFinite(record.admitUntil) ||
    record.admitUntil <= now ||
    record.admitUntil > now + 300_000 ||
    record.repo.id !== spec.personalRepo.registryId ||
    record.repo.sharedCheckout !== false ||
    record.repo.default !== false ||
    !record.env.GH_TOKEN ||
    record.env.GH_TOKEN !== record.env.GITHUB_TOKEN
  )
    throw new PersonalRepoRuntimeError();
}
/** Dedicated entrypoint calls this BEFORE importing host/engine modules. */
export async function adoptPersonalHostProjection(
  specPath: string,
  expectedHash: string | undefined,
) {
  const dir = dirname(resolve(specPath));
  await plainDirectory(dir);
  const specInfo = await lstat(specPath);
  if (!specInfo.isFile() || specInfo.isSymbolicLink())
    throw new PersonalRepoRuntimeError();
  const bytes = await readFile(specPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== expectedHash) throw new PersonalRepoRuntimeError();
  const spec = JSON.parse(bytes.toString("utf8")) as RunHostSpec;
  const path = join(dir, PERSONAL_HOST_AUTH_FILE);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o600 ||
    info.uid !== process.getuid?.() ||
    info.size > 64_000
  )
    throw new PersonalRepoRuntimeError();
  try {
    const record = JSON.parse(
      await readFile(path, "utf8"),
    ) as PersonalHostProjection;
    await validatePersonalHostProjection(spec, hash, record);
    adopted = record;
  } finally {
    await unlink(path);
  }
}
export function personalHostProjection(
  binding: PersonalRepoBinding,
  now = Date.now(),
): PersonalHostProjection | undefined {
  if (!adopted) {
    if (process.env.OPENSESSION_RUN_JOURNAL)
      throw new PersonalRepoRuntimeError();
    return undefined;
  }
  assertInstallationProjection(adopted, now);
  if (!samePersonalRepoBinding(adopted.binding, binding))
    throw new PersonalRepoRuntimeError();
  return adopted;
}
export function assertPersonalHostAdopted(spec: RunHostSpec) {
  if (spec.personalRepo && adopted) assertInstallationProjection(adopted);
  if (
    spec.personalRepo &&
    (!adopted ||
      adopted.hostId !== spec.hostId ||
      !samePersonalRepoBinding(adopted.binding, spec.personalRepo))
  )
    throw new PersonalRepoRuntimeError();
}

/** Only after the launcher proves this exact host absent. Never sweeps files or
 * deletes a different launch's credential. Missing means preflight consumed it. */
export async function removePersonalHostProjection(
  spec: RunHostSpec,
  dir: string,
  specHash: string,
) {
  await plainDirectory(dir);
  const path = join(dir, PERSONAL_HOST_AUTH_FILE);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > 64_000
  )
    throw new PersonalRepoRuntimeError();
  const record = JSON.parse(
    await readFile(path, "utf8"),
  ) as PersonalHostProjection;
  if (
    !spec.personalRepo ||
    record.hostId !== spec.hostId ||
    record.osSessionId !== spec.osSessionId ||
    record.specHash !== specHash ||
    record.cwd !== spec.cwd ||
    !samePersonalRepoBinding(record.binding, spec.personalRepo) ||
    record.kind !==
      (await (
        await import("./personal-repo-runtime-policy")
      ).personalHostCredentialKindAsync(spec))
  )
    throw new PersonalRepoRuntimeError();
  const current = await lstat(path);
  if (current.ino !== info.ino || current.dev !== info.dev)
    throw new PersonalRepoRuntimeError();
  await unlink(path);
}

export class PersonalLaunchUncertainError extends Error {
  constructor() {
    super(
      "Personal run-host absence or credential cleanup could not be verified",
    );
  }
}
export async function launchPersonalWithCleanup(
  spec: RunHostSpec,
  dir: string,
  specHash: string,
  input: {
    prepare(): Promise<void>;
    launch(): Promise<void>;
    proveAbsent(): Promise<void>;
    ambiguous(error: unknown): boolean;
  },
) {
  try {
    await input.prepare();
  } catch (error) {
    // A prior/competing launch's unconsumed file may still be live. Mark it
    // uncertain so outer spawn cleanup cannot recursively delete this dir.
    try {
      await lstat(join(dir, PERSONAL_HOST_AUTH_FILE));
    } catch (lookup) {
      if ((lookup as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw new PersonalLaunchUncertainError();
    }
    throw new PersonalLaunchUncertainError();
  }
  try {
    await input.launch();
  } catch (error) {
    if (input.ambiguous(error)) throw error;
    try {
      await input.proveAbsent();
      await removePersonalHostProjection(spec, dir, specHash);
    } catch {
      throw new PersonalLaunchUncertainError();
    }
    throw error;
  }
}
