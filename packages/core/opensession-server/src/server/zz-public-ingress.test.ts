/**
 * public-ingress tests: the isolated public listener serves the registered
 * webhook routes, sandbox dial-back surface and /ingress-health, 404s all
 * other paths bodylessly, shares run-ws.ts's token auth, and rate-limits
 * upgrade attempts per client IP (X-Forwarded-For-aware behind a local
 * reverse proxy). No model runs, no sandboxes.
 *
 * zz- prefix: keeps this at the end of the full suite like the other
 * integration-ish test files (run-ws's module graph pins paths at load).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Deferred imports: public-ingress → run-ws → run-rpc → paths resolves
// OPENSESSION_SESSIONS_DIR/HOME at module load (see zz-run-ws.test.ts).
let ingress: typeof import("./public-ingress");
let runWs: typeof import("./run-ws");
let portalRelay: typeof import("./sandbox-portal-relay");
let webhooks: typeof import("./webhook-server");

let scratch = "";
let configPath = "";
let prevConfigEnv: string | undefined;
let handle: import("./public-ingress").PublicIngressHandle | null = null;
let BASE = "";

function writeConfig(cfg: unknown): void {
  writeFileSync(configPath, JSON.stringify(cfg));
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "bks-ingress-"));
  configPath = join(scratch, "sandbox-config.json");
  prevConfigEnv = process.env.OPENSESSION_SANDBOX_CONFIG;
  process.env.OPENSESSION_SANDBOX_CONFIG = configPath;
  writeConfig({ provider: "local", publicIngress: { enabled: true } });
  ingress = await import("./public-ingress");
  runWs = await import("./run-ws");
  portalRelay = await import("./sandbox-portal-relay");
  webhooks = await import("./webhook-server");
  webhooks.configureWebhookRoutes([
    {
      name: "test-webhook",
      getRoutes: () =>
        new Map([
          ["POST /github/webhook", async () => new Response("accepted")],
        ]),
    } as any,
  ]);
  handle = ingress.startPublicIngress({ port: 0, host: "127.0.0.1" });
  if (!handle) throw new Error("ingress did not start");
  BASE = `127.0.0.1:${handle.port}`;
});

afterAll(() => {
  ingress?.stopPublicIngress();
  if (prevConfigEnv === undefined)
    delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = prevConfigEnv;
  rmSync(scratch, { recursive: true, force: true });
});

describe("public ingress surface", () => {
  test("/ingress-health answers a bare 200 ok", async () => {
    const res = await fetch(`http://${BASE}/ingress-health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("dispatches a registered webhook without exposing the app", async () => {
    const accepted = await fetch(`http://${BASE}/github/webhook`, {
      method: "POST",
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("accepted");
    expect((await fetch(`http://${BASE}/github/webhook`)).status).toBe(404);
  });

  test("every other path is a bodyless 404 (no app surface)", async () => {
    for (const path of [
      "/",
      "/backstage/",
      "/backstage/run-ws/old",
      "/opensession/run-ws/old",
      "/opensession/rpc-ws",
      "/api/sessions",
      "/api/health",
      "/ws",
      "/robots.txt",
    ]) {
      const res = await fetch(`http://${BASE}${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });
});

describe("upgrade auth (shared with run-ws.ts)", () => {
  test("run-ws without a token is 403", async () => {
    ingress.resetPublicIngressRateLimit();
    const res = await fetch(`http://${BASE}/run-ws/rh-nope`, {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("run-ws with a garbage token is 403", async () => {
    runWs.registerRunWsHost("rh-ingress-auth", "right-token");
    try {
      const res = await fetch(
        `http://${BASE}/run-ws/rh-ingress-auth?token=garbage`,
        { headers: { upgrade: "websocket" } },
      );
      expect(res.status).toBe(403);
    } finally {
      runWs.unregisterRunWsHost("rh-ingress-auth");
    }
  });

  test("run-ws with the registered token upgrades (101) and acks", async () => {
    const hostId = "rh-ingress-ok";
    runWs.registerRunWsHost(hostId, "sekrit");
    try {
      const ws = new WebSocket(`ws://${BASE}/run-ws/${hostId}?token=sekrit`);
      const firstMsg = await new Promise<any>((resolve, reject) => {
        ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
      expect(firstMsg.t).toBe("ack"); // run-ws hello-ack — same machinery
      expect(runWs.hasLiveRunWsConnection(hostId)).toBe(true);
      ws.close();
    } finally {
      runWs.unregisterRunWsHost(hostId);
    }
  });

  test("rpc-ws requires host + wsToken", async () => {
    const noHost = await fetch(`http://${BASE}/rpc-ws`, {
      headers: { upgrade: "websocket", authorization: "Bearer whatever" },
    });
    expect(noHost.status).toBe(403);
    runWs.registerRunWsHost("rh-ingress-rpc", "rpc-sekrit");
    try {
      const ws = new WebSocket(
        `ws://${BASE}/rpc-ws?host=rh-ingress-rpc&token=rpc-sekrit`,
      );
      const opened = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 5000);
      });
      expect(opened).toBe(true);
      ws.close();
    } finally {
      runWs.unregisterRunWsHost("rh-ingress-rpc");
    }
  });
});

describe("rate limiting", () => {
  test("31st upgrade attempt in a window is 429; health is exempt", async () => {
    ingress.resetPublicIngressRateLimit();
    let last = 0;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`http://${BASE}/run-ws/rh-flood`, {
        headers: { upgrade: "websocket" },
      });
      last = res.status;
    }
    expect(last).toBe(403); // still auth-rejected, not rate-limited
    const over = await fetch(`http://${BASE}/run-ws/rh-flood`, {
      headers: { upgrade: "websocket" },
    });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    const health = await fetch(`http://${BASE}/ingress-health`);
    expect(health.status).toBe(200);
    ingress.resetPublicIngressRateLimit();
  });

  test("a valid Portal grant bypasses stale sidecars that exhausted the IP bucket", async () => {
    ingress.resetPublicIngressRateLimit();
    for (let i = 0; i < 31; i++) {
      await fetch(
        `http://${BASE}/sandbox-portal-ws?session=os-stale&sandbox=stale&port=4300`,
        {
          headers: { upgrade: "websocket", authorization: "Bearer expired" },
        },
      );
    }
    const grant = portalRelay.mintSandboxPortalGrant({
      sessionId: "os-current",
      sandboxId: "sandbox-current",
      port: 4300,
    });
    const ws = new WebSocket(
      `ws://${BASE}/sandbox-portal-ws?session=os-current&sandbox=sandbox-current&port=4300`,
      { headers: { authorization: `Bearer ${grant.token}` } } as any,
    );
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 5_000);
    });
    expect(opened).toBe(true);
    ws.close();
    portalRelay.revokeSandboxPortalGrants("sandbox-current");
    ingress.resetPublicIngressRateLimit();
  });

  test("buckets key on the proxy-appended (last) X-Forwarded-For hop", async () => {
    ingress.resetPublicIngressRateLimit();
    const hit = (xff: string) =>
      fetch(`http://${BASE}/run-ws/rh-xff`, {
        headers: { upgrade: "websocket", "x-forwarded-for": xff },
      });
    for (let i = 0; i < 31; i++) await hit("203.0.113.7");
    expect((await hit("203.0.113.7")).status).toBe(429);
    // A different client behind the same proxy is NOT limited…
    expect((await hit("203.0.113.8")).status).toBe(403);
    // …and a client-spoofed first hop can't dodge its own bucket: the LAST
    // hop (what the proxy appended) is the key.
    expect((await hit("8.8.8.8, 203.0.113.7")).status).toBe(429);
    ingress.resetPublicIngressRateLimit();
  });
});

describe("always-available loopback ingress", () => {
  test("starts on loopback before a public URL is configured", async () => {
    ingress.stopPublicIngress();
    try {
      writeConfig({ provider: "local" });
      const absent = ingress.startPublicIngress({ port: 0 });
      expect(absent?.hostname).toBe("127.0.0.1");
      absent?.stop(true);
      writeConfig({ provider: "local", publicIngress: { enabled: false } });
      const disabled = ingress.startPublicIngress({ port: 0 });
      expect(disabled?.hostname).toBe("127.0.0.1");
      disabled?.stop(true);
    } finally {
      writeConfig({ provider: "local", publicIngress: { enabled: true } });
      handle = ingress.startPublicIngress({ port: 0, host: "127.0.0.1" });
      BASE = `127.0.0.1:${handle!.port}`;
    }
  });
});
