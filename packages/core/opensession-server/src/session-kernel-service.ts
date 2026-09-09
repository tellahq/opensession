import { startSessionKernelService } from "./server/session-kernel/actor-service";

export async function runSessionKernelService(): Promise<void> {
  const service = await startSessionKernelService({
    // A fail-stopped service has already withdrawn its listener. Staying
    // alive leaves systemd a "running" unit nothing can reach, and every
    // gateway boot dies on "runtime peer generations are unavailable" until
    // an operator restarts the unit by hand. Exit instead: Restart=always
    // brings a fresh service up in seconds.
    onFailed(error) {
      console.error(
        `[session-kernel] fail-stopped; exiting so systemd restarts it: ${error.message}`,
      );
      process.exit(1);
    },
  });
  console.log(`[session-kernel] ready at ${service.url}`);

  let stopping = false;
  function stop(): void {
    if (stopping) return;
    stopping = true;
    // The process exit closes every Worker and SQLite handle. Terminating the
    // bounded worker pool synchronously adds several seconds while the gateway
    // is parked, without improving SQLite's process-crash guarantees.
    service.stop({ terminateWorkers: false });
    process.exit(0);
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.main) await runSessionKernelService();
