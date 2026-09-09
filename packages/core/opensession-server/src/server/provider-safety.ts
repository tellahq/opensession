/** Match provider error text only, never assistant prose or tool output. */
export function isProviderSafetyBlock(
  message: string | null | undefined,
): boolean {
  return (
    !!message &&
    /blocked by (?:our|the) safety systems|\bpotentially unintended activity\b|\bsafety_violation\b|\bcontent_policy_violation\b/i.test(
      message,
    )
  );
}

/** Keep the provider's reason intact while explaining why recovery stopped. */
export function explainProviderSafetyBlock(message: string): string {
  return isProviderSafetyBlock(message)
    ? `${message}\nThe model provider blocked this request. Open Session will not automatically retry it or switch accounts or models.`
    : message;
}
