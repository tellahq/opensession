/** Connectivity proof for the remote-sandbox dial-back boundary. */

import { registerRunWsHost, unregisterRunWsHost } from "../run-ws";
import { configuredIngress } from "../config";

function publicBaseUrl(): string {
  const value = configuredIngress().publicBaseUrl;
  if (!value) {
    throw Object.assign(
      new Error(
        "A public sandbox callback URL is required before remote provider testing",
      ),
      { code: "INGRESS_URL_MISSING" },
    );
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "wss:") {
    throw Object.assign(
      new Error("The public sandbox callback URL must use HTTPS/WSS"),
      { code: "INGRESS_URL_INSECURE" },
    );
  }
  parsed.protocol = "https:";
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error(`${label} timed out`), {
                code: "INGRESS_TIMEOUT",
              }),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Proves both Caddy routing and run-ws authentication through the public URL.
 * The disposable token is registered only for the duration of this probe.
 * A WebSocket `open` is the proof: run-ws validates the token before calling
 * Bun's upgrade API, so an invalid or misrouted request can never open. */
export async function verifyPublicSandboxIngress(): Promise<void> {
  const base = publicBaseUrl();
  const health = await withTimeout(
    fetch(`${base}/ingress-health`),
    10_000,
    "Ingress health check",
  );
  if (!health.ok || (await health.text()).trim() !== "ok") {
    throw Object.assign(
      new Error(`Sandbox ingress health returned HTTP ${health.status}`),
      { code: "INGRESS_HEALTH_FAILED" },
    );
  }

  const hostId = `qualification-${crypto.randomUUID()}`;
  const token = crypto.randomUUID();
  registerRunWsHost(hostId, token);
  try {
    const wsUrl = new URL(`${base}/run-ws/${hostId}`);
    wsUrl.protocol = "wss:";
    wsUrl.searchParams.set("token", token);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        let opened = false;
        socket.onopen = () => {
          opened = true;
          socket.close();
          resolve();
        };
        socket.onerror = () => {
          if (opened) return;
          reject(
            Object.assign(
              new Error("Authenticated sandbox WebSocket probe failed"),
              {
                code: "INGRESS_WEBSOCKET_FAILED",
              },
            ),
          );
        };
        socket.onclose = () => {
          // A successful open closes the socket after resolving; Promise ignores
          // this rejection. A pre-open close is an actionable routing/auth fail.
          if (opened) return;
          reject(
            Object.assign(
              new Error(
                "Sandbox WebSocket closed before authentication completed",
              ),
              {
                code: "INGRESS_WEBSOCKET_FAILED",
              },
            ),
          );
        };
      }),
      10_000,
      "Authenticated sandbox WebSocket probe",
    );
  } finally {
    unregisterRunWsHost(hostId);
  }
}
