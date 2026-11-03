import React from "react";
import { SessionPendingCreationContext } from "../hooks/useSessionPendingCreation";
import type { SessionSocket } from "../hooks/useSessionSocket";
import { MarkdownRepoProvider } from "./MarkdownBody";
import { SessionSocketProvider } from "./SessionSocketProvider";

export function SessionPaneProviders({
  repo,
  socket,
  pendingCreation = false,
  children,
}: {
  repo: string | undefined;
  socket: SessionSocket;
  /** The server has not persisted this pane's session yet. */
  pendingCreation?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <MarkdownRepoProvider repo={repo}>
      <SessionSocketProvider socket={socket}>
        <SessionPendingCreationContext value={pendingCreation}>
          {children}
        </SessionPendingCreationContext>
      </SessionSocketProvider>
    </MarkdownRepoProvider>
  );
}
