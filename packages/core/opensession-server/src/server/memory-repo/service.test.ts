import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../memory-v2/store";
import { git, isolatedGitEnv } from "./git";
import { MemoryRepoService } from "./service";

// Each test drives real git repositories and the commit hook through dozens
// of subprocesses: ~2 s on a quiet host, past bun's 5 s default under load.
setDefaultTimeout(30_000);

let base: string;
let service: MemoryRepoService;

const agentEnv = () =>
  isolatedGitEnv({
    GIT_AUTHOR_NAME: "Agent",
    GIT_AUTHOR_EMAIL: "agent@example.test",
    GIT_COMMITTER_NAME: "Agent",
    GIT_COMMITTER_EMAIL: "agent@example.test",
  });

async function sh(args: string[], cwd: string, check = true) {
  return git(args, { cwd, env: agentEnv(), check });
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "memory-repo-"));
  service = new MemoryRepoService({
    base,
    hookCommand: [
      process.execPath,
      fileURLToPath(new URL("./hook-main.ts", import.meta.url)),
    ],
    uiBase: "https://os.example.test",
    labels: { "user-U1": "Alice" },
  });
});

afterAll(async () => {
  service.close();
  await rm(base, { recursive: true, force: true });
});

describe("MemoryRepoService", () => {
  test("Settings writes are commits and the index follows", async () => {
    await service.ensureRepo("team");
    const added = await service.addEntry(
      {
        scopeKey: "repo-acme",
        text: "bun test needs OPENSESSION_STATE_DIR",
        kind: "gotcha",
        details: "First line of a longer story.\nSecond line.",
        source: "https://os.example.test/session/s-1",
      },
      { name: "Alice" },
    );
    expect(added).toMatchObject({
      scopeKey: "repo-acme",
      kind: "gotcha",
      tier: "retrievable",
      path: "repos/acme/gotchas.md",
    });
    expect(added.details).toContain("Second line.");
    expect(added.source.sessionId).toBe("s-1");

    const pinned = await service.updateEntry(added.id, {
      pinned: true,
      confirmed: "2026-10-05",
    });
    expect(pinned).toMatchObject({
      tier: "pinned",
      path: "repos/acme/MEMORY.md",
    });
    const root = await service.readFile("team", "MEMORY.md");
    expect(root).toContain("- [[repos/acme/MEMORY]]");

    await service.removeEntries([added.id], { name: "Bob" });
    expect(service.index.get(added.id)?.state).toBe("archived");
    expect((await service.restoreEntry(added.id)).state).toBe("active");

    const history = await service.history("team");
    expect(history[0].subject).toStartWith("Restore memory");
    expect(history.some((commit) => commit.author === "Alice")).toBe(true);
  });

  test("a session checkout pushes, is attributed, and bad pushes are refused", async () => {
    const root = join(base, "scratch", "memory");
    const first = await service.ensureCheckouts(root, ["team"], {
      sessionId: "sess-1",
    });
    expect(first).toEqual({ added: ["team"], present: ["team"] });
    const dir = join(root, "team");
    await writeFile(
      join(dir, "release.md"),
      "# Release\n\n- Ship on Tuesdays [id: m-rel; kind: decision]\n",
    );
    await sh(["add", "release.md"], dir);
    await sh(["commit", "-qm", "Remember release day"], dir);
    await sh(["push", "-q", "origin", "main"], dir);
    await service.fresh(["team"]);
    expect(service.index.get("m-rel")).toMatchObject({
      scopeKey: "workspace",
      kind: "decision",
    });
    const [commit] = await service.history("team", { limit: 1 });
    expect(commit.sessionId).toBe("sess-1");

    await writeFile(join(dir, "leak.md"), `- token ghp_${"b".repeat(36)}\n`);
    await sh(["add", "leak.md"], dir);
    await sh(["commit", "-qm", "oops"], dir);
    const refused = await sh(["push", "origin", "main"], dir, false);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("leak.md:1: Looks like a GitHub token");
    await sh(["reset", "-q", "--hard", "origin/main"], dir);

    const branch = await sh(
      ["push", "origin", "HEAD:refs/heads/other"],
      dir,
      false,
    );
    expect(branch.stderr).toContain("Only main can be pushed");
  });

  test("a stale push is rejected and succeeds after pull --rebase", async () => {
    const root = join(base, "scratch2", "memory");
    await service.ensureCheckouts(root, ["team"], { sessionId: "sess-2" });
    const dir = join(root, "team");
    // Another writer lands first.
    await service.addEntry({
      scopeKey: "workspace",
      text: "Prefer concise summaries",
      kind: "preference",
    });
    await writeFile(
      join(dir, "ci.md"),
      "# CI\n\n- CI runs on every push [id: m-ci]\n",
    );
    await sh(["add", "ci.md"], dir);
    await sh(["commit", "-qm", "ci"], dir);
    const stale = await sh(["push", "origin", "main"], dir, false);
    expect(stale.code).not.toBe(0);
    await sh(["pull", "-q", "--rebase", "origin", "main"], dir);
    await sh(["push", "-q", "origin", "main"], dir);
    await service.fresh(["team"]);
    expect(service.index.get("m-ci")?.state).toBe("active");
  });

  test("revert undoes a commit", async () => {
    const added = await service.addEntry({
      scopeKey: "workspace",
      text: "Temporary fact",
    });
    const [commit] = await service.history("team", { limit: 1 });
    await service.revert("team", commit.sha, { name: "Carol" });
    expect(service.index.get(added.id)?.state).toBe("archived");
  });

  test("remote sync pushes and merges without force", async () => {
    const remote = join(base, "remote.git");
    await git(["init", "--bare", "-q", "--initial-branch=main", remote]);
    const status = await service.setRemote("team", remote);
    expect(status.ok).toBe(true);
    const clone = join(base, "remote-clone");
    await git(["clone", "-q", remote, clone]);
    await writeFile(
      join(clone, "from-remote.md"),
      "# Remote\n\n- Added elsewhere [id: m-remote]\n",
    );
    await sh(["add", "-A"], clone);
    await sh(["commit", "-qm", "remote edit"], clone);
    await sh(["push", "-q", "origin", "main"], clone);
    await service.addEntry({
      scopeKey: "workspace",
      text: "Added here meanwhile",
    });
    const synced = await service.syncRemote("team");
    expect(synced.ok).toBe(true);
    expect(service.index.get("m-remote")?.state).toBe("active");
    await sh(["pull", "-q", "--rebase", "origin", "main"], clone);
    expect(await readFile(join(clone, "reference.md"), "utf8")).toContain(
      "Added here meanwhile",
    );
  });

  test("imports memory-v2 with parity, then rolls back new entries", async () => {
    const v2Path = join(base, "v2.sqlite");
    const v2 = new MemoryStore(v2Path);
    const pinned = v2.create({
      scopeKey: "user-U1",
      summary: "Alice prefers bullet summaries.",
      kind: "preference",
      tier: "pinned",
      source: { type: "user-explicit", sessionId: "s-9" },
    });
    const long = v2.create({
      scopeKey: "user-U1",
      summary: "Deploys need a canary.",
      details: "A long explanation.\n".repeat(40),
      kind: "gotcha",
      tier: "retrievable",
      source: { type: "agent-verified" },
    });
    const gone = v2.create({
      scopeKey: "user-U1",
      summary: "Old fact.",
      kind: "reference",
      tier: "retrievable",
      source: { type: "agent-verified" },
    });
    v2.archive(gone.id);
    v2.close();

    const result = await service.migrateFromV2(v2Path, "import");
    expect(result?.parity.ok).toBe(true);
    expect(result?.written).toBe(2);
    expect(service.index.get(pinned.id)).toMatchObject({
      tier: "pinned",
      path: "MEMORY.md",
    });
    expect(service.index.get(long.id)?.details).toContain(
      "A long explanation.",
    );
    expect(service.index.get(gone.id)?.state).toBe("archived");
    expect(await service.migrateFromV2(v2Path, "import")).toBeNull();

    const fresh = await service.addEntry({
      scopeKey: "user-U1",
      text: "Written in repo mode",
    });
    const rollback = await service.rollbackIntoV2(v2Path);
    expect(rollback.created).toBeGreaterThanOrEqual(1);
    const reopened = new MemoryStore(v2Path);
    expect(reopened.get(fresh.id)?.summary).toBe("Written in repo mode");
    reopened.close();
  });
});

test("details that repeat the entry text are not folded in twice", async () => {
  const { distinctDetails } = await import("./service");
  expect(
    distinctDetails("Tests need TZ=UTC.", "Tests need TZ=UTC."),
  ).toBeUndefined();
  expect(
    distinctDetails("Tests need TZ=UTC", "tests need tz=utc."),
  ).toBeUndefined();
  expect(
    distinctDetails(
      "Tests need TZ=UTC.",
      "Tests need TZ=UTC. Date assertions fail otherwise.",
    ),
  ).toBe("Date assertions fail otherwise.");
  expect(distinctDetails("Tests need TZ=UTC", "Seen in CI on Mondays.")).toBe(
    "Seen in CI on Mondays.",
  );
});
