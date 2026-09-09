/** The slice of `/api/sandbox/status` that says where a session can run. */
export interface SandboxAvailability {
  connections?: ReadonlyArray<{ provider: string; state: string }> | null;
  providers?: ReadonlyArray<{
    id: string;
    configured: boolean;
    certified: boolean;
  }> | null;
}

/**
 * Providers a session can run in right now: the Ready connections, or on an
 * instance that predates connections, the configured and certified providers.
 */
export function readySandboxProviders(
  status: SandboxAvailability | null | undefined,
): string[] {
  if (!status) return [];
  if (status.connections?.length)
    return status.connections
      .filter((connection) => connection.state === "ready")
      .map((connection) => connection.provider);
  return (status.providers || [])
    .filter((provider) => provider.configured && provider.certified)
    .map((provider) => provider.id);
}

const PROVIDER_LABELS = new Map([
  ["daytona", "Daytona"],
  ["box", "Box"],
]);

export function sandboxProviderLabel(id: string): string {
  return PROVIDER_LABELS.get(id) ?? id;
}
