/**
 * Which automations belong in the sidebar you are looking at.
 *
 * An automation is owned by a person, the same way a session is started by
 * one, so the sidebar's person lens should narrow both. An automation edits
 * the codebase unattended, so the owner is who reviews what it did.
 *
 * One nobody has taken is the agent's: something set it up, it is still
 * running, and the agent is what runs it. That gives unowned work one named
 * place a person can go and adopt it from, rather than a line in everybody's
 * sidebar that everybody scrolls past.
 */

import { AGENT_NAME, DEFAULT_REPO_ID } from "./brand";

/** The anonymous browser identity used by visual probes and UI automation. */
export const AUTOMATION_MACHINE_IDENTITY = "automation";

/**
 * The person key the agent answers to. It is the agent's own name, so an
 * automation whose owner is set to the agent and one nobody has touched land
 * in the same place, and a session the agent started sits there too.
 */
export const AGENT_PERSON_KEY = AGENT_NAME.trim().toLowerCase();

/**
 * What an automation the overview can't describe counts as: unowned, and so
 * the agent's. The runs of a deleted automation stay in the band long after
 * the automation is gone, and no person is accountable for them.
 */
export const HOUSE_AUTOMATION = {};

/**
 * Does this owner name the person the lens is on? One teammate reaches us as
 * "Kent", "Kent de Bruin" and "kentdebruin" depending on whether the name came
 * from a config roster, a display name or a GitHub login, so the compare is
 * the app's usual loose one: equal, or either a prefix of the other.
 */
export function ownerMatchesPerson(owner: string, personKey: string): boolean {
  const a = owner.trim().toLowerCase();
  const b = personKey.trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * The lens values, spelled out:
 *
 * - `everyone` — every automation.
 * - `me` — the ones you own, and nothing else. An automation edits the
 *   codebase unattended, so your sidebar holds what you are accountable for
 *   reviewing.
 * - the agent's key — the ones nobody has taken. They live there until a
 *   person adopts one.
 * - `unassigned` — no automations. That lens is about work nobody claimed, and
 *   an automation is always either a person's or the agent's.
 * - a person key — the ones that teammate owns.
 */
export function automationInPersonLens(
  automation: { owner?: string },
  person: string,
  currentUser: string,
): boolean {
  if (person === "everyone") return true;
  // "me" stands in for your own name, so resolve it first: the agent signed
  // in as itself then finds its own routines under "me" as well.
  const key =
    person === "me"
      ? currentUser.trim().toLowerCase()
      : person.trim().toLowerCase();
  // Signed out, "mine" can't be answered: show the band rather than empty it.
  if (person === "me" && (!key || key === "anonymous")) return true;
  const owner = (automation.owner || "").trim();
  if (!owner) return key === AGENT_PERSON_KEY;
  if (person === "unassigned") return false;
  return ownerMatchesPerson(owner, key);
}

/**
 * The repo lens, for automations. An automation's own `repo` is where it runs;
 * unset means the instance default, the same fallback the server applies. A
 * workspace it files under can name a different repo, and that counts too, so
 * narrowing to a repo doesn't hide an automation filed in one of its
 * workspaces.
 */
export function automationInRepoLens(
  automation: { repo?: string; workspaceRepo?: string },
  repo: string,
): boolean {
  if (repo === "all") return true;
  return (
    (automation.repo || DEFAULT_REPO_ID) === repo ||
    automation.workspaceRepo === repo
  );
}
