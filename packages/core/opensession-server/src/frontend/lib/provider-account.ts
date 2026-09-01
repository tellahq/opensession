/** The subscription identity shown throughout the UI. Older account records and
 * API-key entries may not have an email, so their internal name remains the
 * compatibility fallback rather than leaving the picker blank. */
export function providerAccountLabel(account: {
  name: string;
  email?: string | null;
}): string {
  return account.email?.trim() || account.name;
}
