/**
 * The session's Claude account pin on the loopback HTTP bridge. The pi
 * runtime sends it as request headers; the bridge passes it to
 * pickBridgeAccount. A pin only narrows the pick (to a designated account
 * the run may use), so it grants a bridge-key holder nothing new. No run
 * user travels this way, so personal accounts still never serve the bridge.
 */
import type { BridgeAccountPin } from "./anthropic-bridge";

const ACCOUNT_HEADER = "x-opensession-account";
const STRICT_HEADER = "x-opensession-account-strict";

export function bridgePinHeaders(
  accountId: string | undefined,
  accountStrict: boolean | undefined,
): Record<string, string> {
  if (!accountId) return {};
  return accountStrict
    ? { [ACCOUNT_HEADER]: accountId, [STRICT_HEADER]: "1" }
    : { [ACCOUNT_HEADER]: accountId };
}

export function bridgePinFromHeaders(
  headers: Headers,
): Pick<BridgeAccountPin, "accountId" | "accountStrict"> {
  const accountId = headers.get(ACCOUNT_HEADER)?.trim() || undefined;
  return {
    accountId,
    accountStrict: !!accountId && headers.get(STRICT_HEADER) === "1",
  };
}
