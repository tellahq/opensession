import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { devInstanceBootError, isDevInstance } from "./dev-mode";
import { stateDir, statePath } from "./paths";

const SAVED_KEYS = [
  "OPENSESSION_DEV",
  "OPENSESSION_STATE_DIR",
  "OPENSESSION_SESSIONS_DIR",
  "HOME",
] as const;
const saved: Record<string, string | undefined> = {};
let scratch = "";

beforeEach(() => {
  for (const k of SAVED_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // HOME must stay set — statePath falls back to os.homedir() without it.
  scratch = mkdtempSync(join(tmpdir(), "os-dev-mode-"));
  process.env.HOME = join(scratch, "home");
  mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("isDevInstance", () => {
  test("true iff OPENSESSION_DEV=1", () => {
    expect(isDevInstance()).toBe(false);
    process.env.OPENSESSION_DEV = "1";
    expect(isDevInstance()).toBe(true);
  });

  test("only the literal '1' enables it", () => {
    for (const v of ["0", "true", "yes", ""]) {
      process.env.OPENSESSION_DEV = v;
      expect(isDevInstance()).toBe(false);
    }
  });

  test("no legacy alias — BACKSTAGE_DEV is not read", () => {
    process.env.BACKSTAGE_DEV = "1";
    try {
      expect(isDevInstance()).toBe(false);
    } finally {
      delete process.env.BACKSTAGE_DEV;
    }
  });
});

describe("devInstanceBootError", () => {
  test("null when not a dev instance", () => {
    expect(devInstanceBootError({})).toBeNull();
    expect(devInstanceBootError({ OPENSESSION_DEV: "0" })).toBeNull();
  });

  test("refuses a dev instance with no state isolation", () => {
    expect(devInstanceBootError({ OPENSESSION_DEV: "1" })).toContain(
      "OPENSESSION_STATE_DIR",
    );
    expect(devInstanceBootError({ OPENSESSION_DEV: "1" })).not.toBeNull();
    // Empty strings are not isolation.
    expect(
      devInstanceBootError({ OPENSESSION_DEV: "1", OPENSESSION_STATE_DIR: "" }),
    ).not.toBeNull();
  });

  test("accepts OPENSESSION_STATE_DIR or a sessions-dir override", () => {
    expect(
      devInstanceBootError({
        OPENSESSION_DEV: "1",
        OPENSESSION_STATE_DIR: "/x",
      }),
    ).toBeNull();
    expect(
      devInstanceBootError({
        OPENSESSION_DEV: "1",
        OPENSESSION_SESSIONS_DIR: "/x",
      }),
    ).toBeNull();
  });

  test("defaults to process.env", () => {
    process.env.OPENSESSION_DEV = "1";
    expect(devInstanceBootError()).not.toBeNull();
    process.env.OPENSESSION_STATE_DIR = "/x";
    expect(devInstanceBootError()).toBeNull();
  });
});

describe("statePath with OPENSESSION_STATE_DIR", () => {
  test("uses the compact home layout and isolates explicit state roots", () => {
    const home = process.env.HOME!;
    const stateRoot = join(scratch, "state");
    mkdirSync(stateRoot, { recursive: true });
    expect(statePath(".opensession-foo")).toBe(
      join(home, ".opensession", "foo"),
    );

    process.env.OPENSESSION_STATE_DIR = stateRoot;
    expect(statePath(".opensession-foo")).toBe(
      join(stateRoot, ".opensession-foo"),
    );
  });

  test("keeps using a legacy home entry until it is migrated", () => {
    const legacy = join(process.env.HOME!, ".opensession-baz");
    mkdirSync(legacy, { recursive: true });
    expect(stateDir("baz")).toBe(legacy);

    mkdirSync(join(process.env.HOME!, ".opensession", "baz"), {
      recursive: true,
    });
    expect(stateDir("baz")).toBe(
      join(process.env.HOME!, ".opensession", "baz"),
    );
  });

  test("unsetting the knob returns to HOME resolution", () => {
    const stateRoot = join(scratch, "state");
    process.env.OPENSESSION_STATE_DIR = stateRoot;
    expect(stateDir("baz")).toBe(join(stateRoot, ".opensession-baz"));
    delete process.env.OPENSESSION_STATE_DIR;
    expect(stateDir("baz")).toBe(
      join(process.env.HOME!, ".opensession", "baz"),
    );
  });
});

describe("sessions-dir resolution with OPENSESSION_STATE_DIR", () => {
  // paths.ts resolves its dir once at module load — re-import cache-busted.
  let n = 0;
  async function freshSessionsDir(): Promise<string> {
    const spec = `./paths?dev-mode-test=${++n}`;
    const mod = (await import(spec as string)) as {
      OPENSESSION_SESSIONS_DIR: string;
    };
    return mod.OPENSESSION_SESSIONS_DIR;
  }

  test("uses <stateRoot>/.opensession-sessions when set", async () => {
    const stateRoot = join(scratch, "state");
    process.env.OPENSESSION_STATE_DIR = stateRoot;
    expect(await freshSessionsDir()).toBe(
      join(stateRoot, ".opensession-sessions"),
    );
  });

  test("OPENSESSION_SESSIONS_DIR still wins over the state root", async () => {
    process.env.OPENSESSION_STATE_DIR = join(scratch, "state");
    process.env.OPENSESSION_SESSIONS_DIR = join(scratch, "sessions-override");
    expect(await freshSessionsDir()).toBe(join(scratch, "sessions-override"));
  });

  test("defaults to the compact home layout without the knob", async () => {
    expect(await freshSessionsDir()).toBe(
      join(process.env.HOME!, ".opensession", "sessions"),
    );
  });
});
