export const NORMAL_WS_RECONNECT_MS = 2_000;
export const HANDOFF_WS_RECONNECT_MS = 250;

/** A graceful server handoff should reconnect promptly without turning an
 * ordinary outage into a tight retry loop. Close code 1012 is the standard
 * Service Restart signal; the explicit frame covers older servers. */
export function webSocketReconnectDelay(
  closeCode: number,
  handoffAnnounced: boolean,
): number {
  return closeCode === 1012 || handoffAnnounced
    ? HANDOFF_WS_RECONNECT_MS
    : NORMAL_WS_RECONNECT_MS;
}
