import { BASE_PATH } from "./base";

const HEALTH_URL = `${BASE_PATH}/api/health?brief=1`;

export interface HealthStatus {
  bootId?: unknown;
  frontendVersion?: unknown;
  [key: string]: unknown;
}

let inflight: Promise<HealthStatus> | null = null;

/** Share concurrent health probes without caching their result. Startup has
 * both restart detection and frontend-version detection listening at once. */
export function fetchHealthStatus(): Promise<HealthStatus> {
  if (inflight) return inflight;
  const pending = fetch(HEALTH_URL, { cache: "no-store" }).then(
    async (response) => {
      if (!response.ok)
        throw new Error(`Health check failed: ${response.status}`);
      return (await response.json()) as HealthStatus;
    },
  );
  inflight = pending;
  void pending
    .finally(() => {
      if (inflight === pending) inflight = null;
    })
    .catch(() => {});
  return pending;
}
