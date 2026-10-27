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
  ["box", "Boat"],
  ["tart", "Mac VM"],
  ["usecomputer", "use.computer"],
  ["modal", "Modal"],
]);

export function sandboxProviderLabel(id: string): string {
  const { provider, gpu } = splitSandboxChoice(id);
  const label = PROVIDER_LABELS.get(provider) ?? provider;
  return gpu ? `${label} · ${gpu} GPU` : label;
}

/** GPUs a Modal Sandbox can carry, and what each offers. */
export const SANDBOX_GPUS = [
  { id: "T4", memory: "16 GB" },
  { id: "L4", memory: "24 GB" },
] as const;

/** Machine-menu entries: each ready provider, and for Modal one entry per
 *  GPU after the plain one (`modal:T4`). */
export function sandboxMachineChoices(providers: readonly string[]): string[] {
  return providers.flatMap((id) =>
    id === "modal"
      ? [id, ...SANDBOX_GPUS.map((gpu) => `${id}:${gpu.id}`)]
      : [id],
  );
}

/** A machine-menu entry as the create request names it. */
export function splitSandboxChoice(choice: string): {
  provider: string;
  gpu?: string;
} {
  const [provider = "", gpu] = choice.split(":");
  return gpu ? { provider, gpu } : { provider };
}

const MAC_PROVIDERS = new Set(["tart", "usecomputer"]);

/** One line on what choosing this machine means, for pickers. The agent
 *  always runs on this server; a Sandbox is a machine attached to the
 *  session for its files, commands, and Portals. */
export function sandboxProviderNote(id: string): string {
  if (id === "") return "A worktree on this server.";
  const { provider, gpu } = splitSandboxChoice(id);
  if (gpu) {
    const memory = SANDBOX_GPUS.find((option) => option.id === gpu)?.memory;
    return `Attached Linux Sandbox with an NVIDIA ${gpu} GPU${memory ? ` (${memory})` : ""}, CUDA and Vulkan. Costs more; sleeps between turns.`;
  }
  if (MAC_PROVIDERS.has(provider))
    return "Attached Mac Sandbox with a desktop. Sleeps between turns, keeps files and Portals.";
  return "Attached Linux Sandbox. Sleeps between turns, keeps files and Portals.";
}
