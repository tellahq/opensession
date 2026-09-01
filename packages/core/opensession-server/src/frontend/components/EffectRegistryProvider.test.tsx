import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { useSessions } from "../hooks/useSessions";
import { useWebSocket } from "../hooks/useWebSocket";
import { EffectRegistryProvider } from "./EffectRegistryProvider";

function RuntimeConsumer() {
  const socket = useWebSocket();
  const sessions = useSessions();
  return (
    <span>
      {socket.connected ? "connected" : "disconnected"}:
      {sessions.loading ? "loading" : "ready"}
    </span>
  );
}

test("server rendering hooks does not start transport or polling I/O", () => {
  let fetches = 0;
  let sockets = 0;
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const previousWebSocket = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocket",
  );
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => {
      fetches++;
      throw new Error("fetch ran during render");
    },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: class extends EventTarget {
      constructor() {
        super();
        sockets++;
        throw new Error("WebSocket ran during render");
      }
    },
  });

  try {
    expect(
      renderToString(
        <EffectRegistryProvider>
          <RuntimeConsumer />
        </EffectRegistryProvider>,
      ),
    ).toContain("disconnected<!-- -->:<!-- -->loading");
    expect(fetches).toBe(0);
    expect(sockets).toBe(0);
  } finally {
    if (previousFetch)
      Object.defineProperty(globalThis, "fetch", previousFetch);
    else Reflect.deleteProperty(globalThis, "fetch");
    if (previousWebSocket)
      Object.defineProperty(globalThis, "WebSocket", previousWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});
