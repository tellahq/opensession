export type BootTransition = "invalid" | "initial" | "same" | "changed";

/** Compare process identities without mistaking the first observed boot for a
 * restart. A baseline learned after a restart announcement may still belong to
 * the draining process, so only a change is completion evidence. */
export function bootTransition(
  previous: string | null,
  value: unknown,
): BootTransition {
  if (typeof value !== "string" || !value) return "invalid";
  if (!previous) return "initial";
  return value === previous ? "same" : "changed";
}
