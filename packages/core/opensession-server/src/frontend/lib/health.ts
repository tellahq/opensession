import { z } from "zod";
import { BASE_PATH } from "./base";

const HEALTH_URL = `${BASE_PATH}/api/health?brief=1`;

const healthStatusSchema = z
  .object({
    bootId: z.string().optional().catch(undefined),
    frontendVersion: z.string().optional().catch(undefined),
  })
  .catch({});

export type HealthStatus = z.infer<typeof healthStatusSchema>;

let inflight: Promise<HealthStatus> | null = null;

/** Share concurrent health probes without caching their result. Startup has
 * both restart detection and frontend-version detection listening at once. */
export function fetchHealthStatus(): Promise<HealthStatus> {
  if (inflight) return inflight;
  const pending = fetch(HEALTH_URL, { cache: "no-store" }).then(
    async (response) => {
      if (!response.ok)
        throw new Error(`Health check failed: ${response.status}`);
      return healthStatusSchema.parse(await response.json());
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
