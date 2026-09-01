import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WSClientMessage, WSServerMessage } from "../lib/types";
import {
  useOptionalSessionSocket,
  useSessionSocket,
  type SessionSocket,
} from "../hooks/useSessionSocket";
import { SessionSocketProvider } from "./SessionSocketProvider";

function StrictConsumer() {
  useSessionSocket();
  return null;
}

function OptionalConsumer({
  inspect,
}: {
  inspect: (socket: SessionSocket | null) => void;
}) {
  inspect(useOptionalSessionSocket());
  return <span>Optional</span>;
}

function SocketConsumer({
  inspect,
}: {
  inspect: (socket: SessionSocket) => void;
}) {
  inspect(useSessionSocket());
  return <span>Connected</span>;
}

describe("SessionSocketProvider", () => {
  test("fails closed outside the provider", () => {
    expect(() => renderToStaticMarkup(<StrictConsumer />)).toThrow(
      "useSessionSocket must be used within SessionSocketProvider",
    );
  });

  test("lets transitional consumers run without a provider", () => {
    let received: SessionSocket | null | undefined;
    expect(
      renderToStaticMarkup(
        <OptionalConsumer inspect={(socket) => (received = socket)} />,
      ),
    ).toBe("<span>Optional</span>");
    expect(received).toBeNull();
  });

  test("provides the exact socket and delegates its capabilities", () => {
    const sent: WSClientMessage[] = [];
    const handlers: Array<(message: WSServerMessage) => void> = [];
    const socket: SessionSocket = {
      send: (message) => sent.push(message),
      addHandler: (handler) => {
        handlers.push(handler);
        return () => {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
    };
    let received: SessionSocket | undefined;

    expect(
      renderToStaticMarkup(
        <SessionSocketProvider socket={socket}>
          <SocketConsumer inspect={(value) => (received = value)} />
        </SessionSocketProvider>,
      ),
    ).toBe("<span>Connected</span>");
    expect(received).toBe(socket);

    received!.send({ type: "ping" });
    const off = received!.addHandler(() => {});
    expect(sent).toEqual([{ type: "ping" }]);
    expect(handlers).toHaveLength(1);
    off();
    expect(handlers).toHaveLength(0);
  });
});
