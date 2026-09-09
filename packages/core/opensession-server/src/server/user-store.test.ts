import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { writeJsonAtomic } from "./shared/atomic-write";
import { NAME_KEYED_STORES, renameUserState } from "./shared/user-store";
import { canonicalName } from "./shared/user-store-key";
import { mergeMapDelta } from "./shared/map-delta";
import {
  APPLICATION_CATALOG_NAMESPACES,
  catalogDocuments,
  importApplicationCatalog,
} from "./catalog-documents";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import { getPins, pinForUser, setPins } from "./pins";
import { getLanes, setLanes, updateLanes } from "./lanes";
import { getHides, updateHides } from "./hides";
import { getSnoozes, updateSnoozes } from "./snoozes";
import {
  getPersonalOutputStyle,
  personalOutputStyleNoteFor,
  setPersonalOutputStyle,
} from "./personal-output-style";
import { getPersonalPrompt, setPersonalPrompt } from "./personal-prompts";

// The catalog mirrors every document to the legacy directory and imports
// legacy files from it, so the state root has to be a scratch dir for the
// whole file, not just at import time.
const root = mkdtempSync(`${tmpdir()}/user-store-test-`);
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

// Every test gets an empty catalog and an empty legacy mirror: the migrated
// stores never read a file, so a fresh in-memory kernel store is the whole
// fixture. Stores that still live in files are cleared alongside.
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
beforeEach(() => {
  for (const name of [
    ...APPLICATION_CATALOG_NAMESPACES,
    ...NAME_KEYED_STORES,
    "personal-prompts",
    "personal-output-styles",
  ]) {
    rmSync(`${root}/.opensession-${name}`, { recursive: true, force: true });
  }
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

/** Write a file under the spelling a store used before the shared filename. */
function seedLegacy(store: string, stem: string, value: unknown): void {
  const dir = `${root}/.opensession-${store}`;
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(`${dir}/${stem}.json`, value);
}

describe("per-user catalog stores", () => {
  test("round-trips one user's state", async () => {
    await setPins("Kent", ["os-1", "os-2"]);
    expect(await getPins("Kent")).toEqual(["os-1", "os-2"]);
    expect(await getPins("Michiel")).toEqual([]);
  });

  // The reason the key carries a hash: these two are different people.
  test("lossy filename characters cannot merge two users", async () => {
    await setPins("a/b", ["os-1"]);
    await setPins("a_b", ["os-2"]);
    expect(await getPins("a/b")).toEqual(["os-1"]);
    expect(await getPins("a_b")).toEqual(["os-2"]);
  });

  test("writes land on the canonical key", async () => {
    await setPins("Kent", ["os-1"]);
    expect(await catalogDocuments("pins").get(canonicalName("Kent"))).toEqual({
      pins: ["os-1"],
    });
  });

  // Live state was written under the plain slug; the boot import carries it
  // into the catalog under that spelling and the read resolves it there.
  test("reads state imported from the legacy plain-slug filename", async () => {
    seedLegacy("pins", "Michiel", { pins: ["os-legacy"] });
    seedLegacy("lanes", "Michiel", { lanes: { "os-legacy": "review" } });
    await importApplicationCatalog();
    expect(await getPins("Michiel")).toEqual(["os-legacy"]);
    expect(await getLanes("Michiel")).toEqual({ "os-legacy": "review" });
  });

  // No file probe on the request path: a legacy file that appeared after the
  // import is invisible until the next boot imports it.
  test("does not fall back to a legacy file on read", async () => {
    seedLegacy("pins", "Michiel", { pins: ["os-legacy"] });
    expect(await getPins("Michiel")).toEqual([]);
  });

  test("the first write moves a legacy user onto the canonical key", async () => {
    seedLegacy("pins", "Michiel", { pins: ["os-legacy"] });
    await importApplicationCatalog();
    await setPins("Michiel", ["os-legacy", "os-new"]);
    expect(await getPins("Michiel")).toEqual(["os-legacy", "os-new"]);
    const documents = catalogDocuments("pins");
    expect(await documents.get(canonicalName("Michiel"))).toEqual({
      pins: ["os-legacy", "os-new"],
    });
    // The legacy row stays as it was: a copy, never a move.
    expect(await documents.get("Michiel")).toEqual({ pins: ["os-legacy"] });
  });

  // The legacy row must never resurrect state the user has since cleared.
  test("clearing wins over the legacy copy", async () => {
    seedLegacy("pins", "Michiel", { pins: ["os-legacy"] });
    await importApplicationCatalog();
    await setPins("Michiel", []);
    expect(await getPins("Michiel")).toEqual([]);
  });

  // An in-place update starts from the legacy row when there is no canonical
  // one yet, so the first delta after a boot does not erase the imported map.
  test("a delta update seeds from the legacy row", async () => {
    seedLegacy("lanes", "Michiel", { lanes: { "os-legacy": "review" } });
    await importApplicationCatalog();
    const next = await updateLanes("Michiel", (lanes) => ({
      ...lanes,
      "os-new": "mine",
    }));
    expect(next).toEqual({ "os-legacy": "review", "os-new": "mine" });
    expect(await getLanes("Michiel")).toEqual(next);
  });

  test("personal prompts still read their identity-keyed legacy file", async () => {
    seedLegacy("personal-prompts", "user-kentaro", { prompt: "be terse" });
    await importApplicationCatalog();
    expect(await getPersonalPrompt("Kentaro")).toBe("be terse");
    await setPersonalPrompt("Kentaro", "be terser");
    expect(await getPersonalPrompt("Kentaro")).toBe("be terser");
  });

  test("personal output styles are identity-keyed and fail closed", async () => {
    expect(await getPersonalOutputStyle("Kentaro")).toBe("default");
    expect(await setPersonalOutputStyle("Kentaro", "concise")).toBe("concise");
    expect(await getPersonalOutputStyle("kentaro")).toBe("concise");
    expect(await personalOutputStyleNoteFor("Kentaro")).toContain(
      "Lead with the result",
    );
    expect(await setPersonalOutputStyle("Kentaro", "unknown")).toBe("default");
    expect(await personalOutputStyleNoteFor("Kentaro")).toBe("");
  });

  test("a nameless user stores nothing", async () => {
    expect(await setPersonalPrompt("", "ignored")).toBe("");
    expect(await getPersonalPrompt("")).toBe("");
    expect(await setPersonalOutputStyle("", "concise")).toBe("default");
    expect(await getPersonalOutputStyle("")).toBe("default");
  });

  test("a missing store reads as empty", async () => {
    expect(await getPins("Nobody")).toEqual([]);
    expect(await getLanes("Nobody")).toEqual({});
    expect(await getPersonalPrompt("Nobody")).toBe("");
  });
});

// Every write is a compare-and-set on the catalog row, so two writers that
// each read the same map cannot erase each other's keys. This is the hazard
// the whole-map PUT carried: the last device to save won.
describe("concurrent updates", () => {
  test("parallel pins all survive", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `os-${i}`);
    await Promise.all(ids.map((id) => pinForUser("Kent", id)));
    expect((await getPins("Kent")).sort()).toEqual([...ids].sort());
  });

  test("pinning the same session twice keeps one entry", async () => {
    await Promise.all([
      pinForUser("Kent", "os-dup"),
      pinForUser("Kent", "os-dup"),
      pinForUser("Kent", "os-other"),
    ]);
    const pins = await getPins("Kent");
    expect(pins.filter((p) => p === "os-dup")).toHaveLength(1);
    expect(pins).toContain("os-other");
  });

  test("parallel lane, hide and snooze deltas keep every key", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `workspace:${i}`);
    const at = "2026-08-20T12:00:00.000Z";
    await Promise.all([
      ...keys.map((key) =>
        updateLanes("Kent", (lanes) =>
          mergeMapDelta(lanes, { set: { [key]: "review" } }),
        ),
      ),
      ...keys.map((key) =>
        updateHides("Kent", (hides) =>
          mergeMapDelta(hides, { set: { [key]: at } }),
        ),
      ),
      ...keys.map((key) =>
        updateSnoozes("Kent", (snoozes) =>
          mergeMapDelta(snoozes, { set: { [key]: "someday" } }),
        ),
      ),
    ]);
    expect(Object.keys(await getLanes("Kent")).sort()).toEqual(keys.sort());
    expect(Object.keys(await getHides("Kent")).sort()).toEqual(keys.sort());
    expect(Object.keys(await getSnoozes("Kent")).sort()).toEqual(keys.sort());
  });

  test("a remove delta lands alongside a concurrent set", async () => {
    await setLanes("Kent", { "os-a": "review", "os-b": "review" });
    await Promise.all([
      updateLanes("Kent", (lanes) =>
        mergeMapDelta(lanes, { remove: ["os-a"] }),
      ),
      updateLanes("Kent", (lanes) =>
        mergeMapDelta(lanes, { set: { "os-c": "mine" } }),
      ),
    ]);
    expect(await getLanes("Kent")).toEqual({
      "os-b": "review",
      "os-c": "mine",
    });
  });

  // The in-process queue serializes this gateway's writers; the revision
  // check is what protects against a writer this process cannot see (another
  // gateway generation during a rollout). Commit a rival write between the
  // read and the put, and the mutation must re-apply on top of it.
  test("re-applies on top of a write that raced from outside the process", async () => {
    await setPins("Kent", ["os-existing"]);
    const put = store.putCatalogDocument.bind(store);
    let rivals = 0;
    store.putCatalogDocument = (input) => {
      if (input.namespace === "pins" && rivals === 0) {
        rivals++;
        const current = store.catalogDocumentGet("pins", input.key);
        put({
          ...input,
          requestId: "rival-generation",
          expectedRev: current?.rev ?? null,
          value: JSON.stringify({ pins: ["os-rival", "os-existing"] }),
        });
      }
      return put(input);
    };
    const next = await pinForUser("Kent", "os-mine");
    expect(rivals).toBe(1);
    expect(next).toEqual(["os-mine", "os-rival", "os-existing"]);
    expect(await getPins("Kent")).toEqual(next);
  });
});

// Renaming yourself on Settings > Personal > Account changes the display name
// these stores file people under, so the state has to travel with the person.
describe("renameUserState", () => {
  test("carries a renamed person's state to the new name", async () => {
    await setPins("Kent", ["os-1"]);
    await setLanes("Kent", { "os-1": "review" });
    const carried = await renameUserState("Kent", "Kentaro");
    expect(carried).toContain("pins");
    expect(carried).toContain("lanes");
    expect(await getPins("Kentaro")).toEqual(["os-1"]);
    expect(await getLanes("Kentaro")).toEqual({ "os-1": "review" });
  });

  // A copy, not a move: the old row is the rollback if the rename was wrong.
  test("leaves the old name's state in place", async () => {
    await setPins("Kent", ["os-1"]);
    await renameUserState("Kent", "Kentaro");
    expect(await getPins("Kent")).toEqual(["os-1"]);
  });

  test("never overwrites state the new name already has", async () => {
    await setPins("Kent", ["os-old"]);
    await setPins("Kentaro", ["os-existing"]);
    expect(await renameUserState("Kent", "Kentaro")).not.toContain("pins");
    expect(await getPins("Kentaro")).toEqual(["os-existing"]);
  });

  // An empty map is state too: someone who cleared their pins under the new
  // name must not get the old name's pins back.
  test("an emptied destination still counts as existing state", async () => {
    await setPins("Kent", ["os-old"]);
    await setPins("Kentaro", []);
    expect(await renameUserState("Kent", "Kentaro")).not.toContain("pins");
    expect(await getPins("Kentaro")).toEqual([]);
  });

  // canonicalName hashes the lowercased name but keeps the original case in
  // the key, so a capitalization fix is a real rename that has to carry.
  test("carries a capitalization fix", async () => {
    await setPins("kent", ["os-1"]);
    await renameUserState("kent", "Kent");
    expect(await getPins("Kent")).toEqual(["os-1"]);
  });

  test("renaming to the same name does nothing", async () => {
    await setPins("Kent", ["os-1"]);
    expect(await renameUserState("Kent", "Kent ")).toEqual([]);
  });

  test("carries state imported from a legacy filename", async () => {
    seedLegacy("pins", "Kent", { pins: ["os-legacy"] });
    await importApplicationCatalog();
    expect(await renameUserState("Kent", "Kentaro")).toContain("pins");
    expect(await getPins("Kentaro")).toEqual(["os-legacy"]);
  });

  // When the old name has both a canonical row and an imported legacy row,
  // the canonical one is the live state (every write since the shared key
  // landed there) and it is what travels.
  test("prefers the canonical row over the legacy row it shadows", async () => {
    seedLegacy("pins", "Kent", { pins: ["os-legacy"] });
    await importApplicationCatalog();
    await setPins("Kent", ["os-canonical"]);
    expect(await renameUserState("Kent", "Kentaro")).toContain("pins");
    expect(await getPins("Kentaro")).toEqual(["os-canonical"]);
    expect(
      await catalogDocuments("pins").get(canonicalName("Kentaro")),
    ).toEqual({
      pins: ["os-canonical"],
    });
  });

  // The copied row is canonical for the new name, so it takes precedence
  // over any legacy spelling of that name, the same as the file store did.
  test("the carried row shadows a legacy row under the new name", async () => {
    seedLegacy("pins", "Kentaro", { pins: ["os-stale"] });
    await importApplicationCatalog();
    await setPins("Kent", ["os-1"]);
    expect(await renameUserState("Kent", "Kentaro")).toContain("pins");
    expect(await getPins("Kentaro")).toEqual(["os-1"]);
  });

  test("a rename racing a write to the new name keeps the write", async () => {
    await setPins("Kent", ["os-old"]);
    await Promise.all([
      renameUserState("Kent", "Kentaro"),
      setPins("Kentaro", ["os-fresh"]),
    ]);
    // Whichever landed first, the person's own write is what remains: either
    // it replaced the carried copy, or the rename saw it and skipped.
    expect(await getPins("Kentaro")).toEqual(["os-fresh"]);
  });

  // Personal run preferences key on the resolved teammate, so they already
  // follow a person through a rename. Copying one would write a file nothing reads.
  test("skips the stores that key on the person rather than the name", () => {
    expect(NAME_KEYED_STORES).not.toContain("personal-prompts" as never);
    expect(NAME_KEYED_STORES).not.toContain("personal-output-styles" as never);
  });

  // The list is hand-maintained, so check it against the real call sites: a
  // store added without a line here would orphan silently on every rename.
  test("covers every name-keyed store in the codebase", async () => {
    const { Glob } = await import("bun");
    const declared = new Set<string>(NAME_KEYED_STORES);
    // Personal run preferences key on the resolved person rather than the
    // display name, so a rename already carries them. Profiles are external.
    declared.add("personal-prompts");
    declared.add("personal-output-styles");
    declared.add("profiles");
    const missing: string[] = [];
    for await (const file of new Glob("src/server/**/*.ts").scan(".")) {
      const source = await Bun.file(file).text();
      if (!/\b(catalogUserStore|userStore)</.test(source)) continue;
      for (const m of source.matchAll(/name:\s*"([a-z-]+)"/g)) {
        if (!declared.has(m[1])) missing.push(`${m[1]} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
