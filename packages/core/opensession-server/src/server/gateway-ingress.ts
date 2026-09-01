#!/usr/bin/env bun

import { join } from "node:path";
import {
  createGatewayTcpProxyMetrics,
  startGatewayTcpProxy,
} from "./gateway-tcp-proxy";
import { readGatewayBackendPort } from "./gateway-routing";
import { createStableFrontendResponder } from "./stable-frontend";

export function inheritedIngressSocketFd(
  env: Record<string, string | undefined> = process.env,
  pid = process.pid,
): number | undefined {
  if (env.LISTEN_PID !== String(pid)) return undefined;
  const count = Number(env.LISTEN_FDS || 0);
  return Number.isInteger(count) && count >= 1 ? 3 : undefined;
}

export async function runGatewayIngress(): Promise<void> {
  const state =
    process.env.OPENSESSION_DEPLOY_STATE ||
    join(process.env.HOME || "", ".opensession/deploy");
  const port = Number(process.env.PORT || 3850);
  const metrics = createGatewayTcpProxyMetrics();
  // Routing reads sit on the per-connection dial path. Cache below the 25ms
  // retry floor so a cut-over is still observed on the next attempt while a
  // connection burst stops re-reading the routing file.
  let cachedBackendPort = 0;
  let backendPortReadAt = 0;
  const backendPort = () => {
    const now = Date.now();
    if (now - backendPortReadAt >= 20) {
      backendPortReadAt = now;
      cachedBackendPort = readGatewayBackendPort(state);
    }
    return cachedBackendPort;
  };
  const stableFrontend = createStableFrontendResponder(state, {
    liveStatus: () => ({
      backendSelected: backendPort() > 0,
      proxy: { ...metrics },
    }),
  });
  const proxy = startGatewayTcpProxy({
    hostname: process.env.HOST || "127.0.0.1",
    port,
    backendPort,
    fallbackHttp: stableFrontend,
    metrics,
    listenFd: inheritedIngressSocketFd(),
  });
  console.log(`[gateway-ingress] stable listener active on 127.0.0.1:${port}`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    proxy.stop(true);
    console.log(`[gateway-ingress] stopped ${JSON.stringify(metrics)}`);
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await new Promise<void>(() => {});
}

if (import.meta.main) await runGatewayIngress();
