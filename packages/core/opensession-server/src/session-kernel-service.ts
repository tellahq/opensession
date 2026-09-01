import { startSessionKernelService } from "./server/session-kernel/actor-service";

export async function runSessionKernelService(): Promise<void> {
  const service = await startSessionKernelService();
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
