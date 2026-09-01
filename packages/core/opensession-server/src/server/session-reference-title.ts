import { findSessionAsync } from "./session-cache";
import type { UnifiedSession } from "./types";
import { getWorkspace } from "./workspaces";

const SESSION_REFERENCE_RE =
  /(^|[^A-Za-z0-9_-])(?:@session:)?((?:os|bks)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![A-Za-z0-9-])/gi;

type SessionName = Pick<UnifiedSession, "title" | "workspaceName">;

/** Replace stable session references with the name people see in the UI. */
export function nameSessionReferencesForTitle(
  prompt: string,
  find: (id: string) => SessionName | undefined,
): string {
  return prompt.replace(SESSION_REFERENCE_RE, (reference, prefix, id) => {
    const session = find(id);
    const name = session?.workspaceName || session?.title;
    return name ? `${prefix}${name}` : reference;
  });
}

/** Resolve references from both the visible session list and owned session files. */
export async function nameKnownSessionReferencesForTitle(
  prompt: string,
): Promise<string> {
  const ids = [
    ...new Set(
      [...prompt.matchAll(SESSION_REFERENCE_RE)].map((match) => match[2]),
    ),
  ];
  const names = new Map<string, SessionName>();
  await Promise.all(
    ids.map(async (id) => {
      const session = await findSessionAsync(id);
      if (!session) return;
      const workspaceName = session.workspaceId
        ? getWorkspace(session.workspaceId)?.name
        : undefined;
      names.set(id, {
        title: session.title,
        workspaceName: session.workspaceName || workspaceName,
      });
    }),
  );
  return nameSessionReferencesForTitle(prompt, (id) => names.get(id));
}
