import { ApiError, request } from "./request";

export async function repairPausedSession(sessionId: string): Promise<void> {
  try {
    await request("/system/session-kernel/dead-letters", {
      method: "POST",
      body: { type: "quarantine", action: "release", sessionId },
      label: "Repair session",
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 403)
      throw new Error(
        "Only a workspace administrator can repair this session.",
      );
    if (error instanceof ApiError && error.status === 404)
      throw new Error(
        "The available evidence is no longer sufficient to repair this session safely.",
      );
    throw error;
  }
}
