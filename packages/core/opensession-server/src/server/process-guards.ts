const INSTALLED = Symbol.for("opensession.unhandledRejectionGuard");

/**
 * Bun exits with status 1 on an unhandled promise rejection. In the gateway
 * that turned one unawaited kernel RPC (a retryable "timed out handling
 * delivery snapshot" reaching a `void generate()` caller, 2026-09-08) into a
 * full process crash, a supervisor restart, and a boot race against the still
 * restarting session kernel. Log the rejection and keep serving: every path
 * that must fail closed already awaits its RPC and fail-stops explicitly.
 *
 * Idempotent, so the supervisor and the gateway child can both call it.
 * Returns false when a guard was already installed in this process.
 */
export function installUnhandledRejectionGuard(
  log: (message: string, reason: unknown) => void = (message, reason) =>
    console.error(message, reason),
): boolean {
  const g = globalThis as typeof globalThis & { [INSTALLED]?: true };
  if (g[INSTALLED]) return false;
  g[INSTALLED] = true;
  process.on("unhandledRejection", (reason) => {
    log("[process] unhandled promise rejection (kept running):", reason);
  });
  return true;
}
