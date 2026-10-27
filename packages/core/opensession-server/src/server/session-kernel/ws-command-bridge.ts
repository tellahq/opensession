/** True only for a recursive command owned by the active outer dispatch. */
export function isInternalKernelDispatch(
  activeTokens: ReadonlySet<string>,
  token: unknown,
): token is string {
  return typeof token === "string" && activeTokens.has(token);
}

/**
 * Keep a handler's response for the outer dispatch that owns `token`. The
 * outer dispatch deletes the entry when it finishes; a token it does not own
 * (one a client put on its own message) is never stored, because nothing
 * would ever delete it.
 */
export function recordInternalKernelResult(
  activeTokens: ReadonlySet<string>,
  results: Map<string, unknown>,
  token: unknown,
  response: unknown,
): void {
  if (isInternalKernelDispatch(activeTokens, token))
    results.set(token, response);
}
