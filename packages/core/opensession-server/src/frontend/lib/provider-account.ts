/** The subscription identity shown throughout the UI: the name a person gave
 * the account in Settings, else its email. Older account records and API-key
 * entries may not have an email, so their internal name remains the
 * compatibility fallback rather than leaving the picker blank. */
export function providerAccountLabel(account: {
  name: string;
  label?: string | null;
  email?: string | null;
}): string {
  return account.label?.trim() || account.email?.trim() || account.name;
}

/** The `owner` that reserves an account for automations (the server's
 * AUTOMATIONS_ACCOUNT_OWNER): only automation runs use it, before the shared
 * pool. No person's name can take this value. */
export const AUTOMATIONS_ACCOUNT_OWNER = "@automations";

export function isAutomationsAccountOwner(owner?: string | null): boolean {
  return owner?.trim().toLowerCase() === AUTOMATIONS_ACCOUNT_OWNER;
}

/** How an account's owner reads in the UI: a person's name, "Automations",
 * or undefined for the shared pool. */
export function accountOwnerLabel(owner?: string | null): string | undefined {
  if (!owner) return undefined;
  return isAutomationsAccountOwner(owner) ? "Automations" : owner;
}

/** One line on who an account serves, for its owner picker. */
export function accountOwnerDescription(owner?: string | null): string {
  if (!owner)
    return "Shared pool account, used by everyone and by automations.";
  if (isAutomationsAccountOwner(owner))
    return "Used only by automations, before the shared pool.";
  return `${owner}'s personal subscription. Their runs use it first, everyone else never does.`;
}
