import { describe, expect, test } from "bun:test";
import {
  createPersonalRepoRuntime,
  type PersonalRepoBinding,
  type PersonalRepoRuntimeDependencies,
} from "./personal-repo-runtime";
import type { PersonalRepositoryCredential } from "./personal-github/repository-coordinator";

const initial: PersonalRepoBinding = {
  registryId: "personal-not-in-global-config",
  descriptor: {
    kind: "personal",
    ownerGithubAccountId: 41,
    appRecordId: "app-a",
    githubAppId: 101,
    installationId: 201,
    repositoryId: 301,
    repositoryOwnerGithubAccountId: 41,
    accessRevision: 1,
    fullName: "owner/private",
  },
};
function fixture() {
  let record = structuredClone(initial);
  let denied = false;
  const gitCalls: unknown[] = [];
  const credentials: string[] = [];
  const deps: PersonalRepoRuntimeDependencies = {
    root: "/synthetic/personal-repositories",
    now: () => 1000,
    async readPersonalRepository(owner, id) {
      if (
        denied ||
        owner !== record.descriptor.ownerGithubAccountId ||
        id !== record.registryId
      )
        throw new Error("denied");
      return structuredClone(record);
    },
    async resolveCredential(owner, descriptor, kind) {
      credentials.push(kind);
      return {
        ok: true,
        credential: {
          ownerGithubAccountId: owner,
          appRecordId: descriptor.appRecordId,
          repositoryId: descriptor.repositoryId,
          installationId: descriptor.installationId,
          accessRevision: descriptor.accessRevision,
          fullName: descriptor.fullName,
          kind,
          token: `synthetic-${kind}`,
          expiresAt: 500_000,
        },
      };
    },
    git: {
      async validate(input) {
        gitCalls.push({ validate: input });
      },
      async defaultBranch(url, env) {
        gitCalls.push({ url, env });
        return "trunk";
      },
      async prepare(input) {
        gitCalls.push(input);
      },
    },
  };
  return {
    deps,
    runtime: createPersonalRepoRuntime(deps),
    gitCalls,
    credentials,
    deny() {
      denied = true;
    },
    change(update: Partial<PersonalRepoBinding["descriptor"]>) {
      record = { ...record, descriptor: { ...record.descriptor, ...update } };
    },
  };
}

describe("personal repository runtime", () => {
  test("resolves absent global ID to catalog-owned immutable config and derived worktree", async () => {
    const f = fixture();
    const resolved = await f.runtime.resolve(41, initial.registryId);
    expect(resolved.repo).toMatchObject({
      id: initial.registryId,
      ghRepo: "owner/private",
      defaultBranch: "trunk",
      sharedCheckout: false,
      default: false,
    });
    expect(resolved.repo.repo).toStartWith(
      "/synthetic/personal-repositories/41/",
    );
    expect(Object.isFrozen(resolved.repo)).toBe(true);
    expect(Object.isFrozen(resolved.binding.descriptor)).toBe(true);
    const prepared = await f.runtime.prepare(41, resolved.binding, {
      sessionId: "../../untrusted-session",
      mode: "code",
    });
    expect(prepared.cwd).toStartWith("/synthetic/personal-repositories/41/");
    expect(prepared.cwd).not.toContain("..");
    expect(prepared.repo.repo).not.toBe(prepared.cwd);
    expect(JSON.stringify(prepared)).not.toContain("synthetic-installation");
  });
  test("wrong owner, blocked/missing and stale tuple fail before clone or credential", async () => {
    const f = fixture();
    await expect(f.runtime.resolve(42, initial.registryId)).rejects.toThrow(
      "Personal repository unavailable",
    );
    await expect(f.runtime.resolve(41, "other")).rejects.toThrow();
    f.change({ accessRevision: 2 });
    await expect(
      f.runtime.prepare(41, initial, { sessionId: "s", mode: "code" }),
    ).rejects.toThrow();
    f.deny();
    await expect(f.runtime.resolve(41, initial.registryId)).rejects.toThrow();
    expect(f.gitCalls).toEqual([]);
    expect(f.credentials).toEqual([]);
  });
  test("creation, recovery and attachment preserve exact repository/session identity", async () => {
    const f = fixture();
    const a = await f.runtime.prepare(41, initial, {
      sessionId: "session-a",
      branch: "feature-a",
      mode: "code",
    });
    const recovered = await f.runtime.prepare(
      41,
      JSON.parse(JSON.stringify(a.binding)),
      { sessionId: "session-a", branch: a.branch, mode: "code" },
    );
    expect(recovered.cwd).toBe(a.cwd);
    const attached = await f.runtime.prepare(41, a.binding, {
      sessionId: "session-b",
      mode: "code",
    });
    expect(attached.cwd).not.toBe(a.cwd);
    const other = {
      ...initial,
      registryId: "personal-other",
      descriptor: { ...initial.descriptor, repositoryId: 302 },
    };
    const otherRuntime = createPersonalRepoRuntime({
      ...f.deps,
      readPersonalRepository: async () => other,
    });
    const second = await otherRuntime.prepare(41, other, {
      sessionId: "session-a",
      mode: "code",
    });
    expect(second.cwd).not.toBe(a.cwd);
    f.change({ appRecordId: "app-reconnected" });
    await expect(
      f.runtime.prepare(41, a.binding, {
        sessionId: "session-a",
        mode: "code",
      }),
    ).rejects.toThrow();
  });
  test("explicit credential modes project exact provenance without ambient fallback", async () => {
    const f = fixture();
    for (const kind of ["installation-read", "installation-write"] as const) {
      const projected = await f.runtime.projectCredential(41, initial, kind);
      expect(projected.kind).toBe(kind);
      expect(projected.env).toMatchObject({
        GH_TOKEN: `synthetic-${kind}`,
        GITHUB_TOKEN: `synthetic-${kind}`,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_SSH_COMMAND: "/bin/false",
      });
      expect(projected.env.GIT_CONFIG_VALUE_1).not.toContain(
        `synthetic-${kind}`,
      );
      expect(projected.env.GH_CONFIG_DIR).toStartWith(
        "/synthetic/personal-repositories/41/",
      );
      expect(JSON.stringify(projected.binding)).not.toContain("token");
    }
    f.deps.resolveCredential = async () => ({
      ok: false,
      code: "credential_denied",
      error: "private-secret-error",
    });
    await expect(
      f.runtime.projectCredential(41, initial, "installation-write"),
    ).rejects.toThrow("Personal repository unavailable");
    expect(f.gitCalls).toEqual([]);
  });
  test("legacy user kind denies before broker or Git access", async () => {
    const f = fixture();
    const legacy = "user" as Parameters<typeof f.runtime.projectCredential>[2];
    await expect(
      f.runtime.projectCredential(41, initial, legacy),
    ).rejects.toThrow();
    await expect(
      f.runtime.projectWorkspaceCredential(41, initial, legacy, {
        sessionId: "s",
        cwd: "/synthetic",
      }),
    ).rejects.toThrow();
    expect(f.credentials).toEqual([]);
    expect(f.gitCalls).toEqual([]);
  });
  test("credential wrong owner/App/revision/kind/expiry cannot reach git", async () => {
    for (const override of [
      { ownerGithubAccountId: 42 },
      { appRecordId: "other" },
      { accessRevision: 2 },
      { kind: "installation-write" },
      { kind: "user" as PersonalRepositoryCredential["kind"] },
      { expiresAt: null },
      { expiresAt: 1001 },
      { token: "" },
    ] as Partial<PersonalRepositoryCredential>[]) {
      const f = fixture();
      const resolve = f.deps.resolveCredential;
      f.deps.resolveCredential = async (...args) => {
        const result = await resolve(...args);
        if (!result.ok) return result;
        return { ok: true, credential: { ...result.credential, ...override } };
      };
      await expect(f.runtime.resolve(41, initial.registryId)).rejects.toThrow();
      expect(f.gitCalls).toEqual([]);
    }
  });
  test("revocation during broker or clone prevents dispatch and redacts failures", async () => {
    const f = fixture();
    const resolver = f.deps.resolveCredential;
    f.deps.resolveCredential = async (...args) => {
      const result = await resolver(...args);
      f.deny();
      return result;
    };
    await expect(f.runtime.resolve(41, initial.registryId)).rejects.toThrow();
    expect(f.gitCalls).toEqual([]);
    const g = fixture();
    g.deps.git.prepare = async () => {
      g.deny();
    };
    await expect(
      g.runtime.prepare(41, initial, { sessionId: "s", mode: "code" }),
    ).rejects.toThrow();
    const h = fixture();
    h.deps.git.prepare = async () => {
      throw new Error("synthetic-user-token");
    };
    try {
      await h.runtime.prepare(41, initial, { sessionId: "s", mode: "code" });
      throw new Error("expected denial");
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-user-token");
    }
  });
});

test("broker canonical name drives clone URL, identity and worktree namespace stay numeric", async () => {
  const f = fixture();
  const resolver = f.deps.resolveCredential;
  f.deps.resolveCredential = async (...args) => {
    const result = await resolver(...args);
    return result.ok
      ? {
          ...result,
          credential: {
            ...result.credential,
            fullName: "renamed-owner/renamed-repository",
          },
        }
      : result;
  };
  const result = await f.runtime.resolve(41, initial.registryId, initial);
  expect(result.repo.ghRepo).toBe("renamed-owner/renamed-repository");
  expect(f.gitCalls[0]).toMatchObject({
    url: "https://github.com/renamed-owner/renamed-repository.git",
  });
  expect(result.binding.descriptor.repositoryId).toBe(301);
  expect(result.repo.repo).toStartWith("/synthetic/personal-repositories/41/");
});
test("host projection cannot authorize an arbitrary or another session's cwd", async () => {
  const f = fixture();
  const prepared = await f.runtime.prepare(41, initial, {
    sessionId: "one",
    mode: "code",
  });
  await f.runtime.assertWorkspace(41, initial, "one", prepared.cwd);
  await expect(
    f.runtime.assertWorkspace(41, initial, "other", prepared.cwd),
  ).rejects.toThrow();
  await expect(
    f.runtime.assertWorkspace(41, initial, "one", prepared.repo.repo),
  ).rejects.toThrow();
  await expect(
    f.runtime.assertWorkspace(42, initial, "one", prepared.cwd),
  ).rejects.toThrow();
});
