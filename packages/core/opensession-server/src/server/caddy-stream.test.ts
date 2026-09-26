import { expect, test } from "bun:test";
import { CADDY_STREAM_CLOSE_DELAY } from "./caddy-stream";
import { previewServerConfig } from "./preview";
import { privateAppCaddySnippet } from "./private-app-domain";
import { upsertCaddyIngress } from "./sandbox/caddy-ingress";

// Without a close delay, a Caddy config reload blocks on any proxied
// WebSocket whose peer stopped reading, holding the config lock for good.
test("every generated reverse proxy delays closing WebSockets on reload", () => {
  expect(CADDY_STREAM_CLOSE_DELAY).not.toBe("0");
  const portal = JSON.stringify(
    previewServerConfig(20000, "127.0.0.1:41000", "portals.example.test"),
  );
  expect(portal).toContain(
    `"upstreams":[{"dial":"127.0.0.1:41000"}],"stream_close_delay":"${CADDY_STREAM_CLOSE_DELAY}"`,
  );
  expect(privateAppCaddySnippet("app.example.test", "100.64.0.1")).toContain(
    `stream_close_delay ${CADDY_STREAM_CLOSE_DELAY}`,
  );
  expect(upsertCaddyIngress("", "https://ingress.example.test")).toContain(
    `stream_close_delay ${CADDY_STREAM_CLOSE_DELAY}`,
  );
});
