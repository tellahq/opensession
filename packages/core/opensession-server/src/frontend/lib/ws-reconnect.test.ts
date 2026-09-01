import { describe, expect, test } from "bun:test";
import {
  HANDOFF_WS_RECONNECT_MS,
  NORMAL_WS_RECONNECT_MS,
  webSocketReconnectDelay,
} from "./ws-reconnect";

describe("webSocketReconnectDelay", () => {
  test("reconnects quickly after an announced handoff", () => {
    expect(webSocketReconnectDelay(1001, true)).toBe(HANDOFF_WS_RECONNECT_MS);
  });

  test("recognizes the standard Service Restart close code", () => {
    expect(webSocketReconnectDelay(1012, false)).toBe(HANDOFF_WS_RECONNECT_MS);
  });

  test("keeps the ordinary outage backoff", () => {
    expect(webSocketReconnectDelay(1006, false)).toBe(NORMAL_WS_RECONNECT_MS);
  });
});
