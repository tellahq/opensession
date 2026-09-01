const PSTACK_COMMAND_RE = /^\/(?:skill:)?(?:pstack|poteto-mode)(?:\s|$)/i;

/** An opening prompt that enables sticky pstack mode for the new session. */
export function enablesPstackMode(text: string): boolean {
  if (!PSTACK_COMMAND_RE.test(text.trim())) return false;
  const input = pstackCommandInput(text);
  return !["off", "disable", "stop"].includes(input.toLowerCase());
}

/** Text after either mode command. Empty means a status request. */
export function pstackCommandInput(text: string): string {
  return text
    .trim()
    .replace(/^\/(?:skill:)?(?:pstack|poteto-mode)\b\s*/i, "")
    .trim();
}

export function isPstackCommand(text: string): boolean {
  return PSTACK_COMMAND_RE.test(text.trim());
}

/**
 * Compact standing context for turns after the skill's full first expansion.
 * It is self-contained so a provider switch or compacted engine session keeps
 * the mode's invariants without depending on a host-only skill path.
 */
export const PSTACK_MODE_NOTE = `## Pstack mode

Pstack mode is enabled for this session. Apply it to every nontrivial turn until the user sends /pstack off or /poteto-mode off.

- Inspect current state and partial work first. Choose the matching investigation, bug-fix, feature, refactor, performance, prototype, review, or shipping playbook.
- Name the authoritative data shape or invariant before editing. Prefer subtraction, one clear owner, typed boundaries, and the smallest coherent change.
- Reproduce bugs and measure performance before changing them. Fix the owning mechanism rather than hiding symptoms.
- Break large work into independently verifiable slices. Use Open Session's policy-gated spawn_task capability only when isolated child sessions materially help; review their evidence yourself.
- Verify the real user-facing behavior, protocol, output, or measured path. Compilation alone is not completion.
- Inspect the complete final diff and report the outcome, important tradeoff, exact verification, and remaining risk.

Higher-priority Open Session, repository, and user instructions govern tools, publication, deployment, and external actions. Pstack mode never grants additional access or permission.`;
