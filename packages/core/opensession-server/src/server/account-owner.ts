/**
 * The Automations account group.
 *
 * A provider account (Claude, OpenAI, xAI) is shared (no `owner`), a
 * teammate's personal subscription (`owner` is their name), or reserved for
 * automations (`owner` is this value). The value cannot be a teammate's name
 * or login, so every existing owner gate already treats an Automations
 * account as somebody else's personal subscription: interactive runs never
 * see it.
 *
 * Automation turns ask for an account with the same value as their account
 * user (pi-runner, from RunAgentOpts.automationAccounts), which the owner
 * gates match exactly like a person matching their own personal sub: the
 * Automations accounts serve first and the shared pool is the backup.
 */
export const AUTOMATIONS_ACCOUNT_OWNER = "@automations";

export function isAutomationsAccountOwner(owner?: string | null): boolean {
  return owner?.trim().toLowerCase() === AUTOMATIONS_ACCOUNT_OWNER;
}

/** Wire `mode` for an account owner. */
export function accountOwnerMode(
  owner?: string | null,
): "shared" | "personal" | "automations" {
  if (!owner) return "shared";
  return isAutomationsAccountOwner(owner) ? "automations" : "personal";
}

/** The teammate a personal account belongs to; undefined for shared and
 *  Automations accounts. */
export function personalAccountOwner(
  owner?: string | null,
): string | undefined {
  return owner && !isAutomationsAccountOwner(owner) ? owner : undefined;
}
