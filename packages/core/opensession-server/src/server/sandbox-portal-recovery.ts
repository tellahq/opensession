/** Rebuild a remote Sandbox Portal's process-local relay after restart.
 *
 * Caddy and the durable HTTPS-port allocation outlive Open Session, while the
 * loopback relay and its authorization map deliberately do not. The first
 * authenticated request after restart uses durable presentation metadata only
 * to find a candidate, then verifies the live session and running sandbox
 * before restoring authority. A sleeping or replaced sandbox stays denied.
 */
import { ensureRemoteSandboxPortalAgent } from "./portal-supervisor";
import { portalRouteAuthorized } from "./preview";
import {
  sandboxPortalRelayConnected,
  waitForSandboxPortalRelay,
} from "./sandbox-portal-relay";
import { sandboxAllocationForHttpsPort } from "./sandbox/preview-ports";
import { cachedSandboxPortalOwner } from "./sandbox-portals";
import { findSessionAsync } from "./session-cache";
import { activeSandboxFor } from "./session-sandbox";

const recovering = new Map<number, Promise<boolean>>();

/** Whether the process-local relay behind a durable remote Portal route is
 * connected. Host/runner routes have no sandbox allocation and are already
 * covered by portalRouteAuthorized. */
export function sandboxPortalRouteConnected(httpsPort: number): boolean {
  const allocation = sandboxAllocationForHttpsPort(httpsPort);
  if (!allocation) return portalRouteAuthorized(httpsPort);
  const sessionId = cachedSandboxPortalOwner(
    allocation.sandboxId,
    allocation.containerPort,
  );
  return Boolean(
    sessionId &&
    sandboxPortalRelayConnected({
      sessionId,
      sandboxId: allocation.sandboxId,
      port: allocation.containerPort,
    }),
  );
}

export function recoverSandboxPortalRoute(httpsPort: number): Promise<boolean> {
  const current = recovering.get(httpsPort);
  if (current) return current;
  const recovery = recoverSandboxPortalRouteInner(httpsPort).finally(() =>
    recovering.delete(httpsPort),
  );
  recovering.set(httpsPort, recovery);
  return recovery;
}

async function recoverSandboxPortalRouteInner(
  httpsPort: number,
): Promise<boolean> {
  if (
    portalRouteAuthorized(httpsPort) &&
    sandboxPortalRouteConnected(httpsPort)
  )
    return true;
  const allocation = sandboxAllocationForHttpsPort(httpsPort);
  if (!allocation) return false;
  const sessionId = cachedSandboxPortalOwner(
    allocation.sandboxId,
    allocation.containerPort,
  );
  if (!sessionId) return false;
  const session = await findSessionAsync(sessionId);
  if (!session?.sandbox || session.sandbox.sandboxId !== allocation.sandboxId)
    return false;
  const sandbox = await activeSandboxFor(session);
  if (!sandbox) return false;
  const relayIdentity = {
    sessionId,
    sandboxId: allocation.sandboxId,
    port: allocation.containerPort,
  };
  await ensureRemoteSandboxPortalAgent({
    sessionId,
    sandbox,
    port: allocation.containerPort,
  });
  if (!(await waitForSandboxPortalRelay(relayIdentity))) return false;
  return portalRouteAuthorized(httpsPort);
}
