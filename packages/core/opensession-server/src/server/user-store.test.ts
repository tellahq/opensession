import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { writeJsonAtomic } from "./shared/atomic-write";
import { NAME_KEYED_STORES, renameUserState } from "./shared/user-store";
import { getPins, setPins } from "./pins";
import { getLanes, setLanes } from "./lanes";
import {
  getPersonalOutputStyle,
  personalOutputStyleNoteFor,
  setPersonalOutputStyle,
} from "./personal-output-style";
import { getPersonalPrompt, setPersonalPrompt } from "./personal-prompts";

// Every per-user store resolves its dir per call, so pointing the state root
// at a scratch dir keeps these off the real ~/.opensession-* state.
const root = mkdtempSync(`${tmpdir()}/user-store-test-`);
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

/** Write a file under the spelling a store used before the shared filename. */
function seedLegacy(store: string, stem: string, value: unknown): void {
  const dir = `${root}/.opensession-${store}`;
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(`${dir}/${stem}.json`, value);
}

describe("per-user flat-file stores", () => {
  beforeEach(() => {
    for (const store of [
      "pins",
      "lanes",
      "personal-prompts",
      "personal-output-styles",
    ]) {
      rmSync(`${root}/.opensession-${store}`, { recursive: true, force: true });
    }
  });

  test("round-trips one user's state", () => {
    setPins("Kent", ["os-1", "os-2"]);
    expect(getPins("Kent")).toEqual(["os-1", "os-2"]);
    expect(getPins("Michiel")).toEqual([]);
  });

  // The reason the filename carries a hash: these two are different people.
  test("lossy filename characters cannot merge two users", () => {
    setPins("a/b", ["os-1"]);
    setPins("a_b", ["os-2"]);
    expect(getPins("a/b")).toEqual(["os-1"]);
    expect(getPins("a_b")).toEqual(["os-2"]);
  });

  // Live state was written under the plain slug; it must still resolve.
  test("reads state left under the legacy plain-slug filename", () => {
    seedLegacy("pins", "Michiel", { pins: ["os-legacy"] });
    expect(getPins("Michiel")).toEqual(["os-legacy"]);
    seedLegacy("lanes", "Michiel", { lanes: { "os-legacy": "review" } });
    expect(getLanes("Michiel")).toEqual({ "os-legacy": "review" });
  });

  test("the first write moves a legacy user onto the shared filename", () => {
    seedLegacy("pins", "Michiel", { pins: ["os-legacy"] });
    setPins("Michiel", ["os-legacy", "os-new"]);
    expect(getPins("Michiel")).toEqual(["os-legacy", "os-new"]);
  });

  // A legacy file must never resurrect state the user has since cleared.
  test("clearing wins over the legacy copy", () => {
    seedLegacy("pins", "Michiel", { pins: ["os-legacy"] });
    setPins("Michiel", []);
    expect(getPins("Michiel")).toEqual([]);
  });

  test("personal prompts still read their identity-keyed legacy file", () => {
    seedLegacy("personal-prompts", "user-kentaro", { prompt: "be terse" });
    expect(getPersonalPrompt("Kentaro")).toBe("be terse");
    setPersonalPrompt("Kentaro", "be terser");
    expect(getPersonalPrompt("Kentaro")).toBe("be terser");
  });

  test("personal output styles are identity-keyed and fail closed", () => {
    expect(getPersonalOutputStyle("Kentaro")).toBe("default");
    expect(setPersonalOutputStyle("Kentaro", "concise")).toBe("concise");
    expect(getPersonalOutputStyle("kentaro")).toBe("concise");
    expect(personalOutputStyleNoteFor("Kentaro")).toContain(
      "Lead with the result",
    );
    expect(setPersonalOutputStyle("Kentaro", "unknown")).toBe("default");
    expect(personalOutputStyleNoteFor("Kentaro")).toBe("");
  });

  test("a nameless user stores nothing", () => {
    expect(setPersonalPrompt("", "ignored")).toBe("");
    expect(getPersonalPrompt("")).toBe("");
    expect(setPersonalOutputStyle("", "concise")).toBe("default");
    expect(getPersonalOutputStyle("")).toBe("default");
  });

  test("a missing store reads as empty", () => {
    expect(getPins("Nobody")).toEqual([]);
    expect(getLanes("Nobody")).toEqual({});
    expect(getPersonalPrompt("Nobody")).toBe("");
  });
});

// Renaming yourself on Settings > Personal > Account changes the display name
// these stores file people under, so the state has to travel with the person.
describe("renameUserState", () => {
  beforeEach(() => {
    for (const store of [
      ...NAME_KEYED_STORES,
      "personal-prompts",
      "personal-output-styles",
    ]) {
      rmSync(`${root}/.opensession-${store}`, { recursive: true, force: true });
    }
  });

  test("carries a renamed person's state to the new name", () => {
    setPins("Kent", ["os-1"]);
    setLanes("Kent", { "os-1": "review" });
    const carried = renameUserState("Kent", "Kentaro");
    expect(carried).toContain("pins");
    expect(carried).toContain("lanes");
    expect(getPins("Kentaro")).toEqual(["os-1"]);
    expect(getLanes("Kentaro")).toEqual({ "os-1": "review" });
  });

  // A copy, not a move: the old file is the rollback if the rename was wrong.
  test("leaves the old name's state in place", () => {
    setPins("Kent", ["os-1"]);
    renameUserState("Kent", "Kentaro");
    expect(getPins("Kent")).toEqual(["os-1"]);
  });

  test("never overwrites state the new name already has", () => {
    setPins("Kent", ["os-old"]);
    setPins("Kentaro", ["os-existing"]);
    expect(renameUserState("Kent", "Kentaro")).not.toContain("pins");
    expect(getPins("Kentaro")).toEqual(["os-existing"]);
  });

  // canonicalName hashes the LOWERCASED name but keeps the original case in
  // the filename stem, so a capitalization fix is still a different file and
  // still has to carry. This is the case that would otherwise look harmless.
  test("carries a capitalization fix", () => {
    setPins("kent", ["os-1"]);
    expect(renameUserState("kent", "Kent")).toContain("pins");
    expect(getPins("Kent")).toEqual(["os-1"]);
  });

  test("renaming to the same name does nothing", () => {
    setPins("Kent", ["os-1"]);
    expect(renameUserState("Kent", "Kent ")).toEqual([]);
  });

  test("carries state left under a legacy filename", () => {
    seedLegacy("pins", "Kent", { pins: ["os-legacy"] });
    expect(renameUserState("Kent", "Kentaro")).toContain("pins");
    expect(getPins("Kentaro")).toEqual(["os-legacy"]);
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
      if (!source.includes("userStore<")) continue;
      for (const m of source.matchAll(/name:\s*"([a-z-]+)"/g)) {
        if (!declared.has(m[1])) missing.push(`${m[1]} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
