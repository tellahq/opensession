import React, { use } from "react";

/**
 * True while this pane shows a session the client has minted but the server
 * has not persisted yet. Session-scoped reads would only return 404 in that
 * window, and SWR keeps that error until the next fetch, so surfaces that show
 * load errors wait for the create instead of asking.
 */
export const SessionPendingCreationContext: React.Context<boolean> =
  React.createContext(false);

export function useSessionPendingCreation(): boolean {
  return use(SessionPendingCreationContext);
}
