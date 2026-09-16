import {
  type FileMention,
  type MentionSuggestionOptions,
  fetchMentionSuggestions,
} from "./api/sessions";

/**
 * Where an "@" palette request is going: a new draft or an existing session,
 * and whether that target is private (a repository from the creator's own
 * GitHub connection). Privacy comes from server-projected metadata only, the
 * same `accessScope` the repository list and session rows carry.
 */
export interface MentionPaletteTarget {
  privateTarget: boolean;
  sessionId?: string;
  user?: string;
  /** The shared draft's service pick. Ignored for a private target. */
  mcpServers?: string[];
}

/** What a palette request says about connected services. */
export interface MentionPaletteScope {
  /** The shared pick, narrowing the server's catalog. Absent means default. */
  mcpServers?: string[];
  /** Narrowing-only: ask for no service rows and skip the catalog entirely. */
  options?: MentionSuggestionOptions;
}

type PaletteFetcher = typeof fetchMentionSuggestions;

/**
 * The service scope a palette request carries. A private target asks for
 * `tools=none`: an omitted or empty `mcp` list means "every connected
 * service" to the server, so only the explicit narrowing option keeps the
 * server from enumerating its service catalog. A private session runs with
 * built-in tools only, so the request never names the shared pick either.
 * The option only ever narrows; the server also forces it for a session it
 * knows is private.
 */
export function mentionPaletteScope(
  privateTarget: boolean,
  mcpServers: string[] | undefined,
): MentionPaletteScope {
  return privateTarget ? { options: { tools: "none" } } : { mcpServers };
}

/** Palette rows without the connected-service entries. */
export function withoutConnectedServices(items: FileMention[]): FileMention[] {
  return items.filter((item) => item.kind !== "tool");
}

/**
 * Non-file "@" rows for a draft. For a private target the request asks for no
 * connected services (`tools=none`) and any service row that still comes
 * back is dropped, so the composer's "Unavailable" readout and the palette
 * agree; workspace and session references, people, files and pasted text
 * stay as they are. A shared target is unchanged.
 */
export async function fetchMentionPalette(
  query: string,
  target: MentionPaletteTarget,
  fetcher: PaletteFetcher = fetchMentionSuggestions,
): Promise<FileMention[]> {
  const scope = mentionPaletteScope(target.privateTarget, target.mcpServers);
  const items = await fetcher(
    query,
    target.sessionId,
    target.user,
    scope.mcpServers,
    scope.options,
  );
  return target.privateTarget ? withoutConnectedServices(items) : items;
}
