/**
 * The adapter signature a workspace Sandbox connection was qualified against.
 * Dependency-free on purpose: sandbox/config.ts (provider usability) and
 * sandbox/connections.ts (the connection store) both need it and must not
 * import each other.
 */
export type WorkspaceSandboxProvider = "daytona" | "box";

export function sandboxAdapterSignature(
  provider: WorkspaceSandboxProvider,
): string {
  const version =
    provider === "box"
      ? "connection-v4"
      : provider === "daytona"
        ? "connection-v2"
        : "connection-v1";
  return `${provider}:${version}`;
}

/** Connection qualification proves provider credentials and control-plane
 * semantics. Runner pins and remote bootstrap revisions have their own
 * re-bootstrap lifecycle and must not make a healthy connection disappear
 * after every deploy. Accept the previous signature shape once so existing
 * qualified connections migrate without another destructive provider test. */
export function sandboxAdapterSignatureCurrent(
  provider: WorkspaceSandboxProvider,
  stored: string | undefined,
): boolean {
  const current = sandboxAdapterSignature(provider);
  return stored === current || stored?.startsWith(`${current}:`) === true;
}
