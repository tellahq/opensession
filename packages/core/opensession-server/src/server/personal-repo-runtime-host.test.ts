import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunHostSpec } from "../runner-host/protocol";
import {
  PERSONAL_HOST_AUTH_FILE,
  launchPersonalWithCleanup,
  removePersonalHostProjection,
  personalHostProjection,
  adoptPersonalHostProjection,
  assertPersonalHostAdopted,
  validatePersonalHostProjection,
  writePersonalHostProjection,
  type PersonalHostProjection,
} from "./personal-repo-runtime-host";

// Existing actor classification consults roster/persona config. Keep even
// those reads on synthetic state, including the gateway policy worker.
const policyRoot = await mkdtemp(join(tmpdir(), "personal-policy-fixture-"));
const previousConfig = process.env.OPENSESSION_CONFIG;
process.env.OPENSESSION_CONFIG = join(policyRoot, "config.json");
await writeFile(process.env.OPENSESSION_CONFIG, "{}");
afterAll(async () => {
  const { closePersonalPolicyClient } =
    await import("./personal-repo-runtime-policy");
  closePersonalPolicyClient();
  if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previousConfig;
  await rm(policyRoot, { recursive: true, force: true });
});

const spec: RunHostSpec = {
  hostId: "rh-019d2a5f-4ac8-7000-8000-123456789abc",
  logicalRunId: "rh-019d2a5f-4ac8-7000-8000-123456789abc",
  mcpServers: [],
  proxyMcpServers: [],
  osSessionId: "synthetic-session",
  prompt: "synthetic",
  cwd: "/synthetic/worktree",
  mode: "ask",
  journalKind: "prompt",
  user: "Alice",
  personalRepo: {
    registryId: "personal-synthetic",
    descriptor: {
      kind: "personal",
      ownerGithubAccountId: 41,
      appRecordId: "app",
      githubAppId: 1,
      installationId: 2,
      repositoryId: 3,
      repositoryOwnerGithubAccountId: 41,
      accessRevision: 1,
      fullName: "owner/private",
    },
  },
};
function projection(hash = "hash"): PersonalHostProjection {
  return {
    version: 1,
    hostId: spec.hostId,
    osSessionId: spec.osSessionId,
    specHash: hash,
    cwd: spec.cwd,
    binding: spec.personalRepo!,
    repo: {
      id: spec.personalRepo!.registryId,
      label: "fixture",
      repo: "/synthetic/repository",
      wtPrefix: "fixture",
      ghRepo: "owner/private",
      defaultBranch: "trunk",
      sharedCheckout: false,
      default: false,
    },
    kind: "installation-read",
    admitUntil: Date.now() + 60_000,
    expiresAt: Date.now() + 3600_000,
    env: { GH_TOKEN: "synthetic-only", GITHUB_TOKEN: "synthetic-only" },
  };
}
test("personal host projection binds owner, tuple, host, session, cwd, mode and expiry", async () => {
  await expect(
    validatePersonalHostProjection(spec, "hash", projection()),
  ).resolves.toBeUndefined();
  for (const change of [
    { hostId: "other" },
    { osSessionId: "other" },
    { specHash: "other" },
    { cwd: "/other" },
    { kind: "installation-write" },
    { expiresAt: Date.now() - 1 },
    { version: 0 },
  ] as Partial<PersonalHostProjection>[])
    await expect(
      validatePersonalHostProjection(spec, "hash", {
        ...projection(),
        ...change,
      }),
    ).rejects.toThrow();
  const altered = projection();
  altered.binding = {
    ...altered.binding,
    descriptor: { ...altered.binding.descriptor, ownerGithubAccountId: 42 },
  };
  await expect(
    validatePersonalHostProjection(spec, "hash", altered),
  ).rejects.toThrow();
  expect(() => assertPersonalHostAdopted(spec)).toThrow();
});
test("projection is private-mode, one-use, not present in spec and refuses symlinks/overwrite", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "personal-projection-"));
  try {
    const dir = join(tmp, spec.hostId);
    await mkdir(dir);
    const bytes = JSON.stringify(spec);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(dir, "spec.json"), bytes);
    await writePersonalHostProjection(dir, projection(hash));
    expect((await lstat(join(dir, PERSONAL_HOST_AUTH_FILE))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readFile(join(dir, "spec.json"), "utf8")).not.toContain(
      "synthetic-only",
    );
    await expect(
      writePersonalHostProjection(dir, projection(hash)),
    ).rejects.toThrow();
    await adoptPersonalHostProjection(join(dir, "spec.json"), hash);
    expect(() => assertPersonalHostAdopted(spec)).not.toThrow();
    // Admission is one-use. Later provider retries/config lookups retain the
    // real credential lifetime, not the five-minute startup window.
    expect(
      personalHostProjection(spec.personalRepo!, Date.now() + 6 * 60_000)?.env
        .GH_TOKEN,
    ).toBe("synthetic-only");
    expect(() =>
      personalHostProjection(spec.personalRepo!, Date.now() + 2 * 3600_000),
    ).toThrow();
    const active = personalHostProjection(spec.personalRepo!)!;
    const original = { kind: active.kind, expiresAt: active.expiresAt };
    for (const change of [
      { kind: "user" },
      { expiresAt: null },
      { expiresAt: Number.NaN },
      { expiresAt: Infinity },
      { expiresAt: Date.now() - 1 },
    ]) {
      Object.assign(active, original, change);
      expect(() => personalHostProjection(spec.personalRepo!)).toThrow();
      expect(() => assertPersonalHostAdopted(spec)).toThrow();
    }
    Object.assign(active, original);
    await expect(lstat(join(dir, PERSONAL_HOST_AUTH_FILE))).rejects.toThrow();
    await symlink(join(dir, "spec.json"), join(dir, PERSONAL_HOST_AUTH_FILE));
    await expect(
      adoptPersonalHostProjection(join(dir, "spec.json"), hash),
    ).rejects.toThrow();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
test("missing projection aborts dedicated entrypoint BEFORE importing host/inference", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "personal-preflight-"));
  try {
    const path = join(tmp, "spec.json");
    const bytes = JSON.stringify(spec);
    await writeFile(path, bytes);
    const proc = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../runner-host/personal-host.ts"),
        path,
      ],
      {
        cwd: tmp,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: tmp,
          OPENSESSION_STATE_DIR: join(tmp, "state"),
          OPENSESSION_RUN_SPEC_HASH: createHash("sha256")
            .update(bytes)
            .digest("hex"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain(
      "Personal host preflight failed",
    );
    await expect(lstat(join(tmp, "startup.json"))).rejects.toThrow();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, 20_000);

test("executor/direct rejection cleans bound projection only after absence, permits fresh retry", async () => {
  for (const failure of ["executor rejected", "direct failed"]) {
    const tmp = await mkdtemp(join(tmpdir(), "personal-launch-cleanup-"));
    const events: string[] = [];
    const prepare = async () => {
      await writePersonalHostProjection(tmp, projection());
      events.push("projected");
    };
    try {
      await expect(
        launchPersonalWithCleanup(spec, tmp, "hash", {
          prepare,
          launch: async () => {
            throw new Error(failure);
          },
          proveAbsent: async () => {
            expect(
              await lstat(join(tmp, PERSONAL_HOST_AUTH_FILE)),
            ).toBeDefined();
            events.push("absent");
          },
          ambiguous: () => false,
        }),
      ).rejects.toThrow(failure);
      expect(events).toEqual(["projected", "absent"]);
      await expect(lstat(join(tmp, PERSONAL_HOST_AUTH_FILE))).rejects.toThrow();
      await launchPersonalWithCleanup(spec, tmp, "hash", {
        prepare,
        launch: async () => {},
        proveAbsent: async () => {
          throw new Error("must not stop successful launch");
        },
        ambiguous: () => false,
      });
      expect(await lstat(join(tmp, PERSONAL_HOST_AUTH_FILE))).toBeDefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
});
test("ambiguous/live or mismatched projections are retained and denied, never erased", async () => {
  for (const mode of [
    "ambiguous",
    "absence-unknown",
    "mismatched",
    "prepare-existing",
  ] as const) {
    const tmp = await mkdtemp(join(tmpdir(), "personal-launch-uncertain-"));
    try {
      const record = projection(
        mode === "mismatched" ? "different-spec" : "hash",
      );
      if (mode === "prepare-existing")
        await writePersonalHostProjection(tmp, record);
      let probes = 0;
      await expect(
        launchPersonalWithCleanup(spec, tmp, "hash", {
          prepare: () => writePersonalHostProjection(tmp, record),
          launch: async () => {
            throw new Error("failed");
          },
          proveAbsent: async () => {
            probes++;
            if (mode === "absence-unknown")
              throw new Error("host may still be live");
          },
          ambiguous: () => mode === "ambiguous",
        }),
      ).rejects.toThrow();
      expect(await lstat(join(tmp, PERSONAL_HOST_AUTH_FILE))).toBeDefined();
      if (mode === "ambiguous" || mode === "prepare-existing")
        expect(probes).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
});

test("personal preflight rejects missing/malformed logical lineage and spec-hash rebinding", async () => {
  for (const logicalRunId of [undefined, "", "../other", "with space"]) {
    await expect(
      validatePersonalHostProjection(
        { ...spec, logicalRunId },
        "hash",
        projection(),
      ),
    ).rejects.toThrow();
  }
  const originalHash = createHash("sha256")
    .update(JSON.stringify(spec))
    .digest("hex");
  const changed = { ...spec, logicalRunId: "another-logical-run" };
  const changedHash = createHash("sha256")
    .update(JSON.stringify(changed))
    .digest("hex");
  await expect(
    validatePersonalHostProjection(
      changed,
      changedHash,
      projection(originalHash),
    ),
  ).rejects.toThrow();
});

test("personal preflight never admits configured MCP defaults or proxy grants", async () => {
  for (const change of [
    { mcpServers: "all" as const },
    { mcpServers: undefined },
    { proxyMcpServers: ["opensession-admin"] },
    { rpcToken: "synthetic-shared-grant" },
  ]) {
    await expect(
      validatePersonalHostProjection(
        { ...spec, ...change },
        "hash",
        projection(),
      ),
    ).rejects.toThrow("MCP");
  }
});

test("legacy user and invalid installation projections fail before writing or adoption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "personal-legacy-projection-"));
  const codeSpec = {
    ...spec,
    mode: "code",
    user: "Alice",
    journalKind: "prompt",
  };
  const bytes = JSON.stringify(codeSpec);
  const hash = createHash("sha256").update(bytes).digest("hex");
  try {
    await writeFile(join(dir, "spec.json"), bytes);
    for (const change of [
      { kind: "user", expiresAt: Date.now() + 3600_000 },
      { kind: "user", expiresAt: null },
      { kind: "installation-write", expiresAt: null },
      { kind: "installation-write", expiresAt: Infinity },
      { kind: "installation-write", expiresAt: Number.NaN },
      { kind: "installation-write", expiresAt: Date.now() - 1 },
    ]) {
      const record = {
        ...projection(hash),
        ...change,
      } as PersonalHostProjection;
      await expect(writePersonalHostProjection(dir, record)).rejects.toThrow();
      await expect(lstat(join(dir, PERSONAL_HOST_AUTH_FILE))).rejects.toThrow();
      // Simulate an old executable's hash-correct, owned, mode-0600 serialized file.
      await writeFile(
        join(dir, PERSONAL_HOST_AUTH_FILE),
        JSON.stringify(record),
        { mode: 0o600 },
      );
      await expect(
        adoptPersonalHostProjection(join(dir, "spec.json"), hash),
      ).rejects.toThrow();
      await expect(lstat(join(dir, PERSONAL_HOST_AUTH_FILE))).rejects.toThrow();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleanup preserves legacy user projection evidence instead of reinterpreting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "personal-legacy-cleanup-"));
  try {
    const bytes = JSON.stringify({
      ...projection(),
      kind: "user",
      expiresAt: null,
    });
    const path = join(dir, PERSONAL_HOST_AUTH_FILE);
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(
      removePersonalHostProjection(spec, dir, "hash"),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
