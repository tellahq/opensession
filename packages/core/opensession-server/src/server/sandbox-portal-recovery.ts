/** Rebuild a remote Sandbox Portal's process-local relay after restart.
 *
 * Caddy and the durable HTTPS-port allocation outlive Open Session, while the
 * loopback relay and its authorization map deliberately do not. The first
 * authenticated request after restart uses durable presentation metadata only
 * to find a candidate, then verifies the live session and running sandbox
 * before restoring authority. A replaced sandbox stays denied. A sleeping one
 * is woken only for a person's navigation (`wake`); a fetch stays denied.
 */
import {
  ensureRemoteSandboxPortalAgent,
  sandboxPortalOperationPending,
} from "./portal-supervisor";
import { portalRouteAuthorized } from "./preview";
import {
  sandboxPortalRelayConnected,
  waitForSandboxPortalRelay,
} from "./sandbox-portal-relay";
import { sandboxAllocationForHttpsPort } from "./sandbox/preview-ports";
import {
  cachedSandboxPortalOwner,
  cachedSandboxPortalService,
} from "./sandbox-portals";
import { findSessionAsync } from "./session-cache";
import { activeSandboxFor, restoreSandboxPortals } from "./session-sandbox";

type RecoveryOptions = {
  /** Resume a sleeping Sandbox. Only a person's navigation asks for this;
   * a fetch never spends compute. */
  wake?: boolean;
};

const recovering = new Map<
  number,
  { promise: Promise<boolean>; wake: boolean }
>();

/** Whether a recovery for this route is in flight right now. */
export function sandboxPortalRouteRecovering(httpsPort: number): boolean {
  return recovering.has(httpsPort);
}

/** Whether the Portal behind this route is being started right now (a
 * start, restart, or wake-restore holds its operation lock), from durable
 * presentation metadata; false for host/runner routes. */
export function sandboxPortalRouteStarting(httpsPort: number): boolean {
  const allocation = sandboxAllocationForHttpsPort(httpsPort);
  if (!allocation) return false;
  const service = cachedSandboxPortalService(
    allocation.sandboxId,
    allocation.containerPort,
  );
  return Boolean(
    service &&
    sandboxPortalOperationPending(allocation.sandboxId, service.name),
  );
}

/** The session that last registered the Portal behind this route, from the
 * durable presentation metadata; null for host/runner routes. */
export function sandboxPortalRouteSession(httpsPort: number): string | null {
  const allocation = sandboxAllocationForHttpsPort(httpsPort);
  if (!allocation) return null;
  return (
    cachedSandboxPortalOwner(allocation.sandboxId, allocation.containerPort) ??
    // The Portal on this port may be gone from the cache (replaced by one
    // on another port); the Sandbox still names the session to go back to.
    cachedSandboxPortalOwner(allocation.sandboxId)
  );
}

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

/**
 * Rebuild the route, sharing one attempt between concurrent requests. The
 * promise never rejects: a failure is a `false` the caller turns into the
 * right status, so a navigation that stopped waiting for it and moved on
 * to its waiting page leaves no unhandled rejection behind.
 */
export function recoverSandboxPortalRoute(
  httpsPort: number,
  options: RecoveryOptions = {},
): Promise<boolean> {
  const wake = Boolean(options.wake);
  const current = recovering.get(httpsPort);
  if (current) {
    if (!wake || current.wake) return current.promise;
    // A fetch's attempt is running without permission to wake. Let it
    // finish; if the Sandbox turned out to be asleep, try again with it.
    return current.promise.then((ok) =>
      ok ? ok : recoverSandboxPortalRoute(httpsPort, options),
    );
  }
  const promise = recoverSandboxPortalRouteInner(httpsPort, wake)
    .catch((error) => {
      console.warn(`[portals] Portal ${httpsPort} recovery failed:`, error);
      return false;
    })
    .finally(() => {
      if (recovering.get(httpsPort)?.promise === promise)
        recovering.delete(httpsPort);
    });
  recovering.set(httpsPort, { promise, wake });
  return promise;
}

async function recoverSandboxPortalRouteInner(
  httpsPort: number,
  wake: boolean,
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
  const sandbox = await activeSandboxFor(session, { wake });
  if (!sandbox) return false;
  // A missing relay can also mean the provider restarted the Sandbox on its
  // own (an idle stop), which took every Portal process with it while the
  // session's lifecycle never saw a wake. Relaunch the dead ones now, before
  // the relay comes back, or the route would connect to nothing and answer
  // 502 until the person restarts the Portal by hand.
  await restoreSandboxPortals(session, sandbox, { onlyDead: true });
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
