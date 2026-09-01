import { describe, expect, test } from "bun:test";
import { AGENT_PERSON_KEY } from "./automation-audience";
import { AGENT_NAME } from "./brand";
import {
  canonicalNames,
  ownerKey,
  ownerKeyOf,
  sessionHasOwner,
  sessionOwners,
} from "./session-owner";
import type { Person } from "./people";
import type { UnifiedSession } from "./types";

const roster: Person[] = [
  { name: "Kent", fullName: "Kent de Bruin", github: "kentdebruin" },
  { name: "Michiel", fullName: "Michiel Westerbeek", github: "happylinks" },
];
const canonical = canonicalNames(roster);

function session(p: Partial<UnifiedSession>): UnifiedSession {
  return {
    id: "s",
    title: "t",
    archived: true,
    lastActivity: "",
    ...p,
  } as UnifiedSession;
}

describe("session owner lens", () => {
  test("merges a person's first-name, full-name and login spellings", () => {
    expect(
      ownerKeyOf(session({ startedBy: "Michiel Westerbeek" }), canonical),
    ).toBe("michiel");
    expect(ownerKeyOf(session({ startedBy: "michiel" }), canonical)).toBe(
      "michiel",
    );
    expect(ownerKeyOf(session({ startedBy: "happylinks" }), canonical)).toBe(
      "michiel",
    );
  });

  test("a qualifier is the same person: a loop runs on their behalf", () => {
    expect(ownerKey("Kent (loop)", canonical)).toBe("kent");
    // Only the qualifier is dropped, never a name of its own.
    expect(ownerKey("Kent Robinson", canonical)).toBe("kent robinson");
  });

  test("falls back to the raw name when the directory is empty", () => {
    expect(ownerKeyOf(session({ startedBy: "Kent" }), new Map())).toBe("kent");
  });

  test("files the anonymous browser identity under the agent", () => {
    const machine = session({
      createdBy: "Automation",
      startedBy: "Automation",
    });
    expect(ownerKeyOf(machine, canonical)).toBe(AGENT_PERSON_KEY);
    expect(sessionHasOwner(machine, "michiel", canonical)).toBe(false);
    expect(sessionHasOwner(machine, AGENT_PERSON_KEY, canonical)).toBe(true);
    expect(sessionOwners([machine], canonical)).toEqual([
      { key: AGENT_PERSON_KEY, label: AGENT_NAME },
    ]);
  });

  test("offers only directory people, most-active first, without me", () => {
    const owners = sessionOwners(
      [
        session({ startedBy: "Michiel Westerbeek" }),
        session({ startedBy: "Michiel" }),
        session({ startedBy: "Kent" }),
        // Not teammates: a spawned worker, a goal, an integration sender,
        // the agent persona, an unmapped Slack id, an automation run.
        session({
          startedBy: "worker os-019fe194-5fbe-7000-a81e-d0a656ad77f4",
        }),
        session({ startedBy: "Publish the OS 0.4.0 Mac release (goal)" }),
        session({ startedBy: "Slack" }),
        session({ startedBy: "Agent" }),
        session({ startedBy: "USLACK" }),
        session({ startedBy: "Kent", automation: "nightly" }),
      ],
      canonical,
      "kent",
    );
    expect(owners).toEqual([{ key: "michiel", label: "Michiel" }]);
  });

  test("every teammate is offered when nobody is excluded", () => {
    const owners = sessionOwners(
      [
        session({ startedBy: "Kent" }),
        session({ startedBy: "Michiel Westerbeek" }),
      ],
      canonical,
    );
    expect(owners.map((o) => o.key).sort()).toEqual(["kent", "michiel"]);
  });

  test("a person's rows exclude automations they started", () => {
    expect(
      sessionHasOwner(session({ startedBy: "Kent" }), "kent", canonical),
    ).toBe(true);
    expect(
      sessionHasOwner(
        session({ startedBy: "Kent", automation: "nightly" }),
        "kent",
        canonical,
      ),
    ).toBe(false);
    expect(sessionHasOwner(session({}), "kent", canonical)).toBe(false);
  });
});
