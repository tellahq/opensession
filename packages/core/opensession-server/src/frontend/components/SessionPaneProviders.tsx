import React from "react";
import type { SessionSocket } from "../hooks/useSessionSocket";
import { MarkdownRepoProvider } from "./MarkdownBody";
import { SessionSocketProvider } from "./SessionSocketProvider";

export function SessionPaneProviders({
  repo,
  socket,
  children,
}: {
  repo: string | undefined;
  socket: SessionSocket;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <MarkdownRepoProvider repo={repo}>
      <SessionSocketProvider socket={socket}>{children}</SessionSocketProvider>
    </MarkdownRepoProvider>
  );
}
