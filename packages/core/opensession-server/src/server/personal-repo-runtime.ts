import { isPersonalCredentialKind } from "./personal-github/repository-coordinator";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Repo } from "./config";
import { githubGitCredentialEnvWithHelper } from "./github-git-credential-env";
import type { PersonalGithubResult } from "./personal-github/errors";
import type {
  PersonalCredentialKind,
  PersonalRepositoryCredential,
} from "./personal-github/repository-coordinator";
import type { PersonalRepositoryDescriptor } from "./personal-github/types";

/** Serializable identity only; never a credential or caller-supplied path. */
export interface PersonalRepoBinding {
  readonly registryId: string;
  readonly descriptor: PersonalRepositoryDescriptor;
}
export interface PersonalRepoGit {
  validate(input: {
    repository: string;
    cwd: string;
    fullName: string;
    env: Record<string, string>;
    branch?: string;
  }): Promise<void>;
  defaultBranch(url: string, env: Record<string, string>): Promise<string>;
  prepare(input: {
    repo: Readonly<Repo>;
    cwd: string;
    branch: string;
    mode: "ask" | "code";
    env: Record<string, string>;
  }): Promise<void>;
}
export interface PersonalRepoRuntimeDependencies {
  root: string;
  readPersonalRepository(
    owner: number,
    registryId: string,
  ): Promise<PersonalRepoBinding>;
  resolveCredential(
    owner: number,
    descriptor: PersonalRepositoryDescriptor,
    kind: PersonalCredentialKind,
  ): Promise<
    PersonalGithubResult<{ credential: PersonalRepositoryCredential }>
  >;
  git: PersonalRepoGit;
  now?: () => number;
}
export class PersonalRepoRuntimeError extends Error {
  constructor() {
    super("Personal repository unavailable or binding changed.");
    this.name = "PersonalRepoRuntimeError";
  }
}
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const fields = [
  "kind",
  "ownerGithubAccountId",
  "appRecordId",
  "githubAppId",
  "installationId",
  "repositoryId",
  "repositoryOwnerGithubAccountId",
  "accessRevision",
  "fullName",
] as const;
export function samePersonalRepoBinding(
  a: PersonalRepoBinding,
  b: PersonalRepoBinding,
): boolean {
  return (
    a.registryId === b.registryId &&
    fields.every(
      (field) =>
        field === "fullName" || a.descriptor[field] === b.descriptor[field],
    )
  );
}
function checked(
  owner: number,
  registryId: string,
  value: PersonalRepoBinding,
): PersonalRepoBinding {
  const d = value?.descriptor;
  if (
    !positive(owner) ||
    typeof registryId !== "string" ||
    !registryId ||
    registryId.length > 256 ||
    value?.registryId !== registryId ||
    !d ||
    d.kind !== "personal" ||
    d.ownerGithubAccountId !== owner ||
    d.repositoryOwnerGithubAccountId !== owner ||
    !positive(d.githubAppId) ||
    !positive(d.installationId) ||
    !positive(d.repositoryId) ||
    !positive(d.accessRevision) ||
    typeof d.appRecordId !== "string" ||
    !d.appRecordId ||
    d.appRecordId.length > 256 ||
    typeof d.fullName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(d.fullName) ||
    [".", ".."].includes(d.fullName.split("/")[1]!)
  )
    throw new PersonalRepoRuntimeError();
  return Object.freeze({
    registryId,
    descriptor: Object.freeze(
      Object.fromEntries(
        fields.map((key) => [key, d[key]]),
      ) as unknown as PersonalRepositoryDescriptor,
    ),
  });
}
function validBranch(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    value
      .split("/")
      .every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

/** Application scoping on the disclosed shared host, NOT OS isolation. */
export function createPersonalRepoRuntime(
  deps: PersonalRepoRuntimeDependencies,
) {
  if (!isAbsolute(deps.root)) throw new PersonalRepoRuntimeError();
  const root = resolve(deps.root);
  const now = deps.now ?? Date.now;
  const lanes = new Map<string, Promise<unknown>>();
  const paths = (b: PersonalRepoBinding, sessionId?: string) => {
    const base = join(
      root,
      String(b.descriptor.ownerGithubAccountId),
      digest(b.registryId),
    );
    return {
      base,
      repo: join(base, "repository"),
      home: join(base, "home"),
      ...(sessionId ? { cwd: join(base, "worktrees", digest(sessionId)) } : {}),
    };
  };
  async function current(
    owner: number,
    registryId: string,
    expected?: PersonalRepoBinding,
  ) {
    try {
      if (
        !positive(owner) ||
        typeof registryId !== "string" ||
        !registryId ||
        registryId.length > 256
      )
        throw new PersonalRepoRuntimeError();
      const b = checked(
        owner,
        registryId,
        await deps.readPersonalRepository(owner, registryId),
      );
      if (
        expected &&
        !samePersonalRepoBinding(b, checked(owner, registryId, expected))
      )
        throw new PersonalRepoRuntimeError();
      return b;
    } catch {
      throw new PersonalRepoRuntimeError();
    }
  }
  async function credential(
    owner: number,
    b: PersonalRepoBinding,
    kind: PersonalCredentialKind,
  ) {
    if (!isPersonalCredentialKind(kind)) throw new PersonalRepoRuntimeError();
    try {
      const result = await deps.resolveCredential(owner, b.descriptor, kind);
      if (!result.ok) throw new PersonalRepoRuntimeError();
      const c = result.credential;
      const d = b.descriptor;
      if (
        !c ||
        c.kind !== kind ||
        c.ownerGithubAccountId !== owner ||
        c.appRecordId !== d.appRecordId ||
        c.repositoryId !== d.repositoryId ||
        c.installationId !== d.installationId ||
        c.accessRevision !== d.accessRevision ||
        typeof c.fullName !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(c.fullName) ||
        [".", ".."].includes(c.fullName.split("/")[1]!) ||
        typeof c.token !== "string" ||
        !c.token ||
        /[\r\n\0]/.test(c.token) ||
        (c.expiresAt !== null &&
          (!Number.isFinite(c.expiresAt) || c.expiresAt <= now() + 60_000)) ||
        c.expiresAt === null
      )
        throw new PersonalRepoRuntimeError();
      await current(owner, b.registryId, b);
      return c;
    } catch {
      throw new PersonalRepoRuntimeError();
    }
  }
  function environment(
    b: PersonalRepoBinding,
    c: PersonalRepositoryCredential,
  ): Record<string, string> {
    const helper = /^bun(\b|-|\.|$)/i.test(basename(process.execPath))
      ? `!${quote(process.execPath)} ${quote(resolve(import.meta.dir, "../../../../../scripts/gh-credential.ts"))}`
      : `!${quote(process.execPath)} github-credential`;
    return {
      ...githubGitCredentialEnvWithHelper(c.token, helper),
      HOME: paths(b).home,
      GIT_CEILING_DIRECTORIES: paths(b).base,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSH_COMMAND: "/bin/false",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GH_CONFIG_DIR: join(paths(b).home, "gh"),
      GIT_CONFIG_COUNT: "7",
      GIT_CONFIG_KEY_4: "core.hooksPath",
      GIT_CONFIG_VALUE_4: "/dev/null",
      GIT_CONFIG_KEY_5: "protocol.file.allow",
      GIT_CONFIG_VALUE_5: "never",
      GIT_CONFIG_KEY_6: "protocol.ext.allow",
      GIT_CONFIG_VALUE_6: "never",
    };
  }
  async function resolveRepository(
    owner: number,
    registryId: string,
    expected?: PersonalRepoBinding,
  ) {
    const b = await current(owner, registryId, expected);
    const c = await credential(owner, b, "installation-read");
    let defaultBranch: string;
    try {
      defaultBranch = await deps.git.defaultBranch(
        `https://github.com/${c.fullName}.git`,
        environment(b, c),
      );
    } catch {
      throw new PersonalRepoRuntimeError();
    }
    if (!validBranch(defaultBranch)) throw new PersonalRepoRuntimeError();
    await current(owner, registryId, b);
    const repo: Readonly<Repo> = Object.freeze({
      id: registryId,
      label: c.fullName,
      repo: paths(b).repo,
      wtPrefix: `personal-${digest(registryId)}`,
      defaultBranch,
      ghRepo: c.fullName,
      host: "github",
      sharedCheckout: false,
      default: false,
    });
    return Object.freeze({ repo, binding: b });
  }
  async function prepare(
    owner: number,
    expected: PersonalRepoBinding,
    input: { sessionId: string; mode: "ask" | "code"; branch?: string },
  ) {
    if (
      typeof input.sessionId !== "string" ||
      !input.sessionId ||
      input.sessionId.length > 256 ||
      !["ask", "code"].includes(input.mode) ||
      (input.branch !== undefined && !validBranch(input.branch))
    )
      throw new PersonalRepoRuntimeError();
    const b = await current(owner, expected.registryId, expected);
    const key = paths(b).base;
    const work = (lanes.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const resolved = await resolveRepository(owner, b.registryId, b);
        const c = await credential(owner, b, "installation-read");
        if (c.fullName !== resolved.repo.ghRepo)
          throw new PersonalRepoRuntimeError();
        const cwd = paths(b, input.sessionId).cwd!;
        const branch =
          input.branch ?? `os-${digest(input.sessionId).slice(0, 24)}`;
        try {
          await deps.git.prepare({
            repo: resolved.repo,
            cwd,
            branch,
            mode: input.mode,
            env: environment(b, c),
          });
        } catch {
          throw new PersonalRepoRuntimeError();
        }
        await current(owner, b.registryId, b);
        return Object.freeze({ ...resolved, cwd, branch, mode: input.mode });
      });
    lanes.set(key, work);
    try {
      return await work;
    } finally {
      if (lanes.get(key) === work) lanes.delete(key);
    }
  }
  async function workspace(
    owner: number,
    b: PersonalRepoBinding,
    sessionId: string,
    cwd: string,
    c: PersonalRepositoryCredential,
  ) {
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      sessionId.length > 256 ||
      paths(b, sessionId).cwd !== cwd
    )
      throw new PersonalRepoRuntimeError();
    try {
      await deps.git.validate({
        repository: paths(b).repo,
        cwd,
        fullName: c.fullName,
        env: environment(b, c),
      });
      await current(owner, b.registryId, b);
    } catch {
      throw new PersonalRepoRuntimeError();
    }
  }
  async function projectCredential(
    owner: number,
    expected: PersonalRepoBinding,
    kind: PersonalCredentialKind,
  ) {
    if (!isPersonalCredentialKind(kind)) throw new PersonalRepoRuntimeError();
    const b = await current(owner, expected.registryId, expected);
    const c = await credential(owner, b, kind);
    return {
      binding: b,
      kind,
      fullName: c.fullName,
      expiresAt: c.expiresAt,
      env: environment(b, c),
    };
  }
  return {
    resolve: resolveRepository,
    prepare,
    async assertWorkspace(
      owner: number,
      expected: PersonalRepoBinding,
      sessionId: string,
      cwd: string,
    ) {
      const b = await current(owner, expected.registryId, expected);
      const c = await credential(owner, b, "installation-read");
      await workspace(owner, b, sessionId, cwd, c);
    },
    projectCredential,
    /** The final credential's locator, not an earlier resolve's name, owns
     * admission. Same numeric identity/revision does not imply same Git URL. */
    async projectWorkspaceCredential(
      owner: number,
      expected: PersonalRepoBinding,
      kind: PersonalCredentialKind,
      input: { sessionId: string; cwd: string },
    ) {
      if (!isPersonalCredentialKind(kind)) throw new PersonalRepoRuntimeError();
      const resolved = await resolveRepository(
        owner,
        expected.registryId,
        expected,
      );
      const b = await current(owner, expected.registryId, expected);
      const c = await credential(owner, b, kind);
      if (c.fullName !== resolved.repo.ghRepo)
        throw new PersonalRepoRuntimeError();
      await workspace(owner, b, input.sessionId, input.cwd, c);
      return {
        binding: b,
        repo: resolved.repo,
        kind,
        fullName: c.fullName,
        expiresAt: c.expiresAt,
        env: environment(b, c),
      };
    },
  };
}
