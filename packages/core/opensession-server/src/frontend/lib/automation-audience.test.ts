import { describe, expect, test } from "bun:test";
import {
  AGENT_PERSON_KEY,
  automationInPersonLens,
  automationInRepoLens,
  ownerMatchesPerson,
} from "./automation-audience";

describe("ownerMatchesPerson", () => {
  test("matches the same person written three ways", () => {
    for (const written of ["Kent", "Kent de Bruin", "kentdebruin"])
      expect(ownerMatchesPerson(written, "kent")).toBe(true);
  });

  test("does not match a different teammate", () => {
    expect(ownerMatchesPerson("Michiel", "kent")).toBe(false);
    expect(ownerMatchesPerson("Kent", "michiel")).toBe(false);
  });

  test("empty on either side never matches", () => {
    expect(ownerMatchesPerson("", "kent")).toBe(false);
    expect(ownerMatchesPerson("Kent", "  ")).toBe(false);
  });
});

describe("automationInPersonLens", () => {
  const mine = { owner: "Kent" };
  const theirs = { owner: "Michiel" };
  const house = { owner: "" };

  test("everyone keeps the whole band", () => {
    for (const a of [mine, theirs, house])
      expect(automationInPersonLens(a, "everyone", "Kent")).toBe(true);
  });

  test("me keeps only the ones you own", () => {
    expect(automationInPersonLens(mine, "me", "Kent")).toBe(true);
    expect(automationInPersonLens(theirs, "me", "Kent")).toBe(false);
    // Nobody has taken it, so it is the agent's rather than yours by default.
    expect(automationInPersonLens(house, "me", "Kent")).toBe(false);
  });

  test("the agent holds every automation nobody has taken", () => {
    // Including one whose owner never existed on the wire.
    for (const a of [house, {}]) {
      expect(automationInPersonLens(a, AGENT_PERSON_KEY, "Kent")).toBe(true);
      expect(automationInPersonLens(a, "everyone", "Kent")).toBe(true);
    }
    // An owned one is that person's, so it is not also the agent's.
    expect(automationInPersonLens(mine, AGENT_PERSON_KEY, "Kent")).toBe(false);
  });

  test("the agent signed in as itself finds its routines under me", () => {
    expect(automationInPersonLens(house, "me", AGENT_PERSON_KEY)).toBe(true);
  });

  test("a teammate lens keeps only theirs, not the unowned ones", () => {
    expect(automationInPersonLens(theirs, "michiel", "Kent")).toBe(true);
    expect(automationInPersonLens(mine, "michiel", "Kent")).toBe(false);
    expect(automationInPersonLens(house, "michiel", "Kent")).toBe(false);
  });

  test("unassigned holds no automations at all", () => {
    // That lens is about work nobody claimed. An automation is either a
    // person's or the agent's, so it is never in it.
    expect(automationInPersonLens(house, "unassigned", "Kent")).toBe(false);
    expect(automationInPersonLens(mine, "unassigned", "Kent")).toBe(false);
  });

  test("signed out falls back to everything rather than an empty band", () => {
    for (const a of [mine, theirs, house]) {
      expect(automationInPersonLens(a, "me", "")).toBe(true);
      expect(automationInPersonLens(a, "me", "anonymous")).toBe(true);
    }
  });

  test("owner is optional on the wire", () => {
    expect(automationInPersonLens({}, AGENT_PERSON_KEY, "Kent")).toBe(true);
    expect(automationInPersonLens({}, "michiel", "Kent")).toBe(false);
  });
});

describe("automationInRepoLens", () => {
  test("all keeps everything", () => {
    expect(automationInRepoLens({ repo: "opensession" }, "all")).toBe(true);
  });

  test("matches the automation's own repo", () => {
    expect(automationInRepoLens({ repo: "opensession" }, "opensession")).toBe(
      true,
    );
    expect(automationInRepoLens({ repo: "opensession" }, "tella-fusion")).toBe(
      false,
    );
  });

  test("matches through the workspace it files under", () => {
    expect(
      automationInRepoLens(
        { repo: "opensession", workspaceRepo: "tella-fusion" },
        "tella-fusion",
      ),
    ).toBe(true);
  });
});
