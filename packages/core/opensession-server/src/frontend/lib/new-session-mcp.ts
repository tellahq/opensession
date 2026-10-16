import type { RepoOption } from "./new-session-state";

/**
 * Connected services in the /new palette, as they depend on the chosen repo.
 *
 * A private repository's run gets no connected services: the server forces an
 * empty allowlist, grants nothing, and rejects a create that names any. The
 * palette therefore must not present the shared control's "nothing picked
 * means every service" reading for such a repo. The shared pick itself is
 * kept in state, so switching back to a shared repository restores it.
 */
export type McpControlState =
  | { kind: "private" }
  | { kind: "shared"; selected: string[] };

/** Whether the option is a private repository, by the server's own metadata
 * (never inferred from an opaque id or a label). Undefined is shared: Scratch
 * and a repo not yet in the list keep the ordinary control. */
export function isPrivateRepoOption(
  option: Pick<RepoOption, "id" | "accessScope"> | undefined,
): boolean {
  return option?.accessScope?.kind === "personal";
}

export function mcpControlState(
  privateRepo: boolean,
  selected: readonly string[],
): McpControlState {
  return privateRepo
    ? { kind: "private" }
    : { kind: "shared", selected: [...selected] };
}

/** The `mcpServers` field of a create message, or undefined to omit it. A
 * shared create sends the pick when there is one (empty means every service,
 * so it is omitted). A private create never sends the field: the run has no
 * services and the server rejects any explicit list, including a pick made
 * before the repo was switched. */
export function createMcpServers(
  privateRepo: boolean,
  selected: readonly string[],
): string[] | undefined {
  if (privateRepo || !selected.length) return undefined;
  return [...selected];
}

/** The short readout on the Connected services row. */
export function mcpControlReadout(state: McpControlState): string {
  if (state.kind === "private") return "Unavailable";
  return state.selected.length ? `${state.selected.length} on` : "All";
}
