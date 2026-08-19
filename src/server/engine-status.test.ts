import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// State-namespace isolation MUST happen before the first src/server import
// (paths.ts and friends resolve at module load), so engine-status is pulled in
// dynamically below rather than with a static import. Without this the test
// would read the live instance's default model and account pools and assert
// against whatever this box happens to be running.
const SCRATCH = mkdtempSync(join(tmpdir(), "engine-status-"));
const ENGINE_CONFIG = join(SCRATCH, "opencode.json");

const SCRATCH_ENV = {
  OPENSESSION_STATE_DIR: SCRATCH,
  OPENSESSION_SESSIONS_DIR: SCRATCH,
  OPENSESSION_OPENCODE_CONFIG: ENGINE_CONFIG,
  OPENSESSION_CLAUDE_ACCOUNTS_PATH: join(SCRATCH, "claude-accounts.json"),
};

/** Run `fn` with the scratch state namespace in effect, then put the
 *  environment back exactly as it was. `bun test` shares ONE process across
 *  files, so env set at module scope leaks into every test file that loads
 *  later — which is precisely how the pre-existing opencode state-path
 *  failures happen. Don't add to that. */
function withScratchEnv<T>(fn: () => T): T {
  const saved = Object.entries(SCRATCH_ENV).map(
    ([k, v]) => [k, process.env[k], v] as const,
  );
  for (const [k, , v] of saved) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, prev] of saved) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

const mod = await withScratchEnv(
  async () => {
    const mod = await import("./engine-status");
    const { __setCodexAccountsPathForTest } = await import("./codex-accounts");
    // Module-level path in codex-accounts, so env alone wouldn't isolate it.
    __setCodexAccountsPathForTest(join(SCRATCH, "codex-accounts.json"));
    const models = await import("./models");
    return { ...mod, __resetModelCachesForTest: models.__resetModelCachesForTest };
  },
);
const { engineStatus, __resetModelCachesForTest } = mod;

/** Re-point the engine config at `cfg` (null = the file doesn't exist, which
 *  is the fresh-install state) and read the status. Both are read per call. */
function statusWith(cfg: object | null) {
  if (cfg) writeFileSync(ENGINE_CONFIG, JSON.stringify(cfg));
  else rmSync(ENGINE_CONFIG, { force: true });
  return withScratchEnv(() => {
    // models.ts memoizes the default-model store at first read; an earlier
    // test file may have baked in this host's real ~/.opensession state, so
    // drop the caches for the scratch-env read.
    __resetModelCachesForTest();
    return engineStatus();
  });
}

// The status check and the runner must agree on where the engine is. They
// didn't: a second, simpler copy of the lookup in the status path missed the
// nvm fallback and reported "not installed" on a box that was running turns
// (systemd's PATH omits the node bin dir). Same module now — pin the contract
// that makes the two safe to share.
describe("opencode binary lookup", () => {
  test("an explicit but missing OPENSESSION_OPENCODE_BIN is null, not hopeful", async () => {
    const { findOpencodeBin, resolveOpencodeBin } = await import("./opencode-bin");
    const prev = process.env.OPENSESSION_OPENCODE_BIN;
    process.env.OPENSESSION_OPENCODE_BIN = join(SCRATCH, "nope", "opencode");
    try {
      // findOpencodeBin answers "is it installed" — it must say no.
      expect(findOpencodeBin()).toBeNull();
      // resolveOpencodeBin answers "what should I exec" — it hands back the
      // configured path so the failure names what the operator asked for.
      expect(resolveOpencodeBin()).toBe(join(SCRATCH, "nope", "opencode"));
    } finally {
      process.env.OPENSESSION_OPENCODE_BIN = prev;
    }
  });
});

// The release ships no bundled Claude Code; the installed CLI is what every
// Anthropic turn execs. The status has to reflect the file on disk, and it
// must carry the install hint the boot log, doctor and /api/health all print.
describe("claudeCliStatus", () => {
  const { claudeCliStatus, CLAUDE_CLI_INSTALL_HINT } = mod;
  const withBin = <T>(bin: string, fn: () => T): T => {
    const prev = process.env.OPENSESSION_CLAUDE_BIN;
    process.env.OPENSESSION_CLAUDE_BIN = bin;
    try {
      return withScratchEnv(fn);
    } finally {
      if (prev === undefined) delete process.env.OPENSESSION_CLAUDE_BIN;
      else process.env.OPENSESSION_CLAUDE_BIN = prev;
    }
  };

  test("a configured path that does not exist is not ok, and says how to install", () => {
    const s = withBin(join(SCRATCH, "nope", "claude"), () => claudeCliStatus());
    expect(s.ok).toBe(false);
    expect(s.error).toContain("does not exist");
    expect(s.error).toContain(CLAUDE_CLI_INSTALL_HINT);
  });

  test("a configured path that exists but is not executable is not ok", () => {
    const bin = join(SCRATCH, "claude-noexec");
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o644 });
    const s = withBin(bin, () => claudeCliStatus());
    expect(s.ok).toBe(false);
    expect(s.error).toContain("not executable");
  });

  test("a configured executable is ok, with no error", () => {
    const bin = join(SCRATCH, "claude-ok");
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    const s = withBin(bin, () => claudeCliStatus());
    expect(s).toEqual({ path: bin, ok: true, error: null });
  });
});

describe("engineStatus", () => {
  test("a fresh install (no engine config) is not ready, and is one click from fixed", () => {
    const s = statusWith(null);
    expect(s.ready).toBe(false);
    expect(s.bridgeEnabled).toBe(false);
    // The blocker must be the switch, not the empty account pool: enabling is a
    // button, and an operator who adds accounts first still can't run a turn.
    expect(s.blocker).toMatch(/switched off/i);
    expect(s.fixableInApp).toBe(true);
  });

  test("enabled with an empty pool blames the pool, and is not a button", () => {
    const s = statusWith({ enabled: true });
    expect(s.ready).toBe(false);
    expect(s.bridgeEnabled).toBe(true);
    expect(s.blocker).toMatch(/account/i);
    expect(s.fixableInApp).toBe(false);
  });

  test("`enabled: false` is respected, not treated as absent", () => {
    expect(statusWith({ enabled: false }).bridgeEnabled).toBe(false);
  });

  test("every not-ready status carries both a blocker and a fix", () => {
    for (const cfg of [null, { enabled: true }, { enabled: false }]) {
      const s = statusWith(cfg);
      if (s.ready) continue;
      expect(s.blocker?.length).toBeGreaterThan(0);
      expect(s.fix?.length).toBeGreaterThan(0);
    }
  });
});
