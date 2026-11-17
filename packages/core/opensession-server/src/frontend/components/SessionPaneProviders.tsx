import React from "react";
import { SessionPendingCreationContext } from "../hooks/useSessionPendingCreation";
import type { SessionSocket } from "../hooks/useSessionSocket";
import { MarkdownOwnPrsProvider, MarkdownRepoProvider } from "./MarkdownBody";
import { SessionSocketProvider } from "./SessionSocketProvider";

export function SessionPaneProviders({
  repo,
  prs = [],
  socket,
  pendingCreation = false,
  children,
}: {
  repo: string | undefined;
  /** The PRs this pane's session is about; mentions of them stay plain text. */
  prs?: readonly { repo?: string; number?: number }[];
  socket: SessionSocket;
  /** The server has not persisted this pane's session yet. */
  pendingCreation?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <MarkdownRepoProvider repo={repo}>
      <MarkdownOwnPrsProvider prs={prs}>
        <SessionSocketProvider socket={socket}>
          <SessionPendingCreationContext value={pendingCreation}>
            {children}
          </SessionPendingCreationContext>
        </SessionSocketProvider>
      </MarkdownOwnPrsProvider>
    </MarkdownRepoProvider>
  );
}
