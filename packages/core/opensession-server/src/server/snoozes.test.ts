import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import { importApplicationCatalog } from "./catalog-documents";
import {
  getSnoozes,
  setSnoozes,
  SNOOZE_SOMEDAY,
  updateSnoozes,
} from "./snoozes";
import { getSettlements, setSettlements } from "./settlements";

const root = mkdtempSync(join(tmpdir(), "opensession-snoozes-test-"));
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
beforeEach(() => {
  for (const name of ["snoozes", "settlements"])
    rmSync(join(root, `.opensession-${name}`), {
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

function seedLegacy(name: string, stem: string, value: unknown): void {
  const dir = join(root, `.opensession-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify(value));
}

describe("per-user snoozes", () => {
  test("keeps timed and Someday snoozes", async () => {
    await setSnoozes("Michiel", {
      "workspace:timed": "2027-01-01T09:00:00.000Z",
      "workspace:someday": SNOOZE_SOMEDAY,
      "workspace:bad": "later perhaps",
    });
    expect(await getSnoozes("Michiel")).toEqual({
      "workspace:timed": "2027-01-01T09:00:00.000Z",
      "workspace:someday": SNOOZE_SOMEDAY,
    });
  });

  test("migrates Settled rows to Someday once", async () => {
    await setSnoozes("Michiel", {
      "workspace:timed": "2027-01-01T09:00:00.000Z",
    });
    await setSettlements("Michiel", {
      "workspace:new": { state: "settled", at: "2026-08-20T12:00:00Z" },
      "workspace:timed": { state: "settled", at: "2026-08-20T12:00:00Z" },
      "workspace:active": { state: "active", at: "2026-08-20T12:00:00Z" },
    });

    expect(await getSnoozes("Michiel")).toEqual({
      "workspace:new": SNOOZE_SOMEDAY,
      "workspace:timed": "2027-01-01T09:00:00.000Z",
    });
    expect(await getSettlements("Michiel")).toEqual({});

    await setSnoozes("Michiel", {});
    expect(await getSnoozes("Michiel")).toEqual({});
  });

  // Both maps were files under the plain slug before the catalog; the boot
  // import brings them in and the one-time Settled migration still runs.
  test("migrates Settled rows imported from legacy files", async () => {
    seedLegacy("snoozes", "Michiel", {
      snoozes: { "workspace:timed": "2027-01-01T09:00:00.000Z" },
    });
    seedLegacy("settlements", "Michiel", {
      settlements: {
        "workspace:old": { state: "settled", at: "2026-08-20T12:00:00Z" },
      },
    });
    await importApplicationCatalog();
    expect(await getSnoozes("Michiel")).toEqual({
      "workspace:old": SNOOZE_SOMEDAY,
      "workspace:timed": "2027-01-01T09:00:00.000Z",
    });
    expect(await getSettlements("Michiel")).toEqual({});
    expect(await getSnoozes("Michiel")).toEqual({
      "workspace:old": SNOOZE_SOMEDAY,
      "workspace:timed": "2027-01-01T09:00:00.000Z",
    });
  });

  test("concurrent deltas keep every snooze", async () => {
    const keys = Array.from({ length: 8 }, (_, i) => `workspace:${i}`);
    await Promise.all(
      keys.map((key) =>
        updateSnoozes("Michiel", (snoozes) => ({
          ...snoozes,
          [key]: SNOOZE_SOMEDAY,
        })),
      ),
    );
    expect(Object.keys(await getSnoozes("Michiel")).sort()).toEqual(
      keys.sort(),
    );
  });
});
