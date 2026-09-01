import React, { use } from "react";
import type { WSClientMessage, WSServerMessage } from "../lib/types";

export type SessionSocketSend = (message: WSClientMessage) => void;
export type SessionSocketAddHandler = (
  handler: (message: WSServerMessage) => void,
) => () => void;

export interface SessionSocket {
  send: SessionSocketSend;
  addHandler: SessionSocketAddHandler;
}

export const IGNORE_WS_MESSAGES: SessionSocketAddHandler = () => () => {};

export const SessionSocketContext: React.Context<SessionSocket | null> =
  React.createContext<SessionSocket | null>(null);

export function useOptionalSessionSocket(): SessionSocket | null {
  return use(SessionSocketContext);
}

export function useSessionSocket(): SessionSocket {
  const socket = useOptionalSessionSocket();
  if (!socket) {
    throw new Error(
      "useSessionSocket must be used within SessionSocketProvider",
    );
  }
  return socket;
}
