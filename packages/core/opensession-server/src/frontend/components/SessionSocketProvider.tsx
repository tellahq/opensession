import React from "react";
import {
  SessionSocketContext,
  type SessionSocket,
} from "../hooks/useSessionSocket";

export function SessionSocketProvider({
  socket,
  children,
}: {
  socket: SessionSocket;
  children: React.ReactNode;
}): React.ReactElement {
  return <SessionSocketContext value={socket}>{children}</SessionSocketContext>;
}
