type CommandResultRecord = Record<string, unknown>;

/**
 * Mark duplicate create results so a reconnected browser can retire its durable
 * command without presenting the historical result as a brand-new session.
 * Other command results keep their existing wire shape.
 */
export function replayedSessionCreatedResult(
  id: string,
  workspaceId?: string | null,
): Record<string, unknown> {
  return {
    type: "session_created",
    id,
    ...(workspaceId ? { workspaceId } : {}),
    replayed: true,
  };
}

export function markReplayedCommandResult(result: unknown): unknown {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    (result as CommandResultRecord).type !== "session_created"
  )
    return result;
  return { ...(result as CommandResultRecord), replayed: true };
}
