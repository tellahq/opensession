import type { UnifiedSession } from "./types";

/**
 * Whether a native session is still only the reusable empty tab it was created
 * as. Keep this in step with the web's sessionNeverRan projection: the server
 * has engine ids, while list clients receive the smaller `ran` summary.
 */
export function isReusableEmptySession(session: UnifiedSession): boolean {
  return (
    session.source === "opensession" &&
    !session.duplicatedFromSessionId &&
    !session.archived &&
    !session.claudeSessionId &&
    !session.codexThreadId &&
    !session.piSessionId &&
    !session.isRunning &&
    session.lastActivity === session.createdAt
  );
}
