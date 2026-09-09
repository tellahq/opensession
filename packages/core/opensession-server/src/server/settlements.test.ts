import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import { getSettlements, setSettlements } from "./settlements";

const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const root = mkdtempSync(join(tmpdir(), "opensession-settlements-test-"));
process.env.OPENSESSION_STATE_DIR = root;

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
beforeEach(() => {
  rmSync(join(root, ".opensession-settlements"), {
    recursive: true,
    force: true,
  });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
});

describe("per-user settlements", () => {
  test("stores explicit settle and unsettle actions independently per person", async () => {
    const at = "2026-08-20T10:00:00.000Z";
    expect(
      await setSettlements("Michiel", {
        "workspace:one": { state: "settled", at },
        "workspace:two": { state: "active", at },
      }),
    ).toEqual({
      "workspace:one": { state: "settled", at },
      "workspace:two": { state: "active", at },
    });
    expect(await getSettlements("Michiel")).toEqual({
      "workspace:one": { state: "settled", at },
      "workspace:two": { state: "active", at },
    });
    expect(await getSettlements("Kent")).toEqual({});
  });

  test("drops malformed row keys and records", async () => {
    expect(
      await setSettlements("Michiel", {
        "workspace:valid": {
          state: "settled",
          at: "2026-08-20T10:00:00.000Z",
        },
        "workspace:bad-state": {
          state: "archived",
          at: "2026-08-20T10:00:00.000Z",
        },
        "workspace:bad-date": { state: "active", at: "soon" },
        "": { state: "active", at: "2026-08-20T10:00:00.000Z" },
      }),
    ).toEqual({
      "workspace:valid": {
        state: "settled",
        at: "2026-08-20T10:00:00.000Z",
      },
    });
  });

  test("keeps the terminal signature, capped", async () => {
    const at = "2026-08-20T10:00:00.000Z";
    const stored = await setSettlements("Michiel", {
      "workspace:one": {
        state: "settled",
        at,
        terminalSignature: "x".repeat(3_000),
      },
      "workspace:two": { state: "active", at, terminalSignature: 42 },
    });
    expect(stored["workspace:one"]!.terminalSignature).toHaveLength(2_000);
    expect(stored["workspace:two"]).toEqual({ state: "active", at });
  });
});
