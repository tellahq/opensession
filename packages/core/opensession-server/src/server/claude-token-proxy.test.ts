/**
 * Token-swap proxy tests against a fake upstream on loopback. No request
 * leaves the machine and no real credential exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  __claudeTokenLeaseCountForTest,
  __setClaudeTokenProxyUpstreamForTest,
  leaseClaudeToken,
} from "./claude-token-proxy";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

const seen: Seen[] = [];
let releaseStream: (() => void) | undefined;
let upstream: ReturnType<typeof Bun.serve>;
let restore: () => void;

beforeAll(() => {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      if (url.pathname === "/redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.test/steal" },
        });
      if (url.pathname === "/gzip")
        return new Response(gzipSync(JSON.stringify({ zipped: true })), {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        });
      if (url.pathname === "/stream") {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode("event: first\n\n"));
              await new Promise<void>((resolve) => (releaseStream = resolve));
              controller.enqueue(encoder.encode("event: second\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json(
        { ok: true },
        { status: 201, headers: { "request-id": "req_1" } },
      );
    },
  });
  restore = __setClaudeTokenProxyUpstreamForTest(
    `http://127.0.0.1:${upstream.port}`,
  );
});

afterAll(() => {
  restore();
  upstream.stop(true);
});

describe("Claude token proxy", () => {
  test("swaps a plan-token placeholder and forwards the request unchanged", async () => {
    const real = "sk-ant-oat01-real-plan-token";
    const lease = leaseClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: real });
    try {
      const placeholder = lease.env.CLAUDE_CODE_OAUTH_TOKEN;
      expect(placeholder).toStartWith("sk-ant-oat01-placeholder-");
      expect(placeholder).not.toContain("real");
      expect(lease.env.ANTHROPIC_BASE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+$/,
      );
      expect(Object.keys(lease.env).sort()).toEqual([
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ]);

      seen.length = 0;
      const response = await fetch(
        `${lease.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${placeholder}`,
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "user-agent": "claude-cli/2.1.322 (external, sdk-cli)",
            "x-app": "cli",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
        },
      );
      expect(response.status).toBe(201);
      expect(response.headers.get("request-id")).toBe("req_1");
      expect(await response.json()).toEqual({ ok: true });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        method: "POST",
        path: "/v1/messages?beta=true",
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });
      expect(seen[0].headers).toMatchObject({
        authorization: `Bearer ${real}`,
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-cli/2.1.322 (external, sdk-cli)",
        "x-app": "cli",
      });
      expect(JSON.stringify(seen[0].headers)).not.toContain(placeholder);
    } finally {
      lease.release();
    }
  });

  test("swaps an API-key placeholder in x-api-key", async () => {
    const lease = leaseClaudeToken({ ANTHROPIC_API_KEY: "sk-ant-api03-real" });
    try {
      const placeholder = lease.env.ANTHROPIC_API_KEY;
      expect(placeholder).toStartWith("sk-ant-api03-placeholder-");
      seen.length = 0;
      await fetch(`${lease.env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": placeholder },
        body: "{}",
      });
      expect(seen[0].headers["x-api-key"]).toBe("sk-ant-api03-real");
      expect(seen[0].headers.authorization).toBeUndefined();
    } finally {
      lease.release();
    }
  });

  test("refuses unknown and released placeholders without calling upstream", async () => {
    const lease = leaseClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: "real" });
    const base = lease.env.ANTHROPIC_BASE_URL;
    const placeholder = lease.env.CLAUDE_CODE_OAUTH_TOKEN;
    const before = __claudeTokenLeaseCountForTest();
    lease.release();
    expect(__claudeTokenLeaseCountForTest()).toBe(before - 1);
    seen.length = 0;
    for (const headers of [
      { authorization: `Bearer ${placeholder}` },
      { authorization: "Bearer real" },
      { "x-api-key": "real" },
      {} as Record<string, string>,
    ]) {
      const response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        type: "error",
        error: { type: "authentication_error" },
      });
    }
    expect(seen).toHaveLength(0);
  });

  test("returns a redirect instead of following it with the credential", async () => {
    const lease = leaseClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: "real" });
    try {
      seen.length = 0;
      const response = await fetch(`${lease.env.ANTHROPIC_BASE_URL}/redirect`, {
        headers: {
          authorization: `Bearer ${lease.env.CLAUDE_CODE_OAUTH_TOKEN}`,
        },
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://elsewhere.example.test/steal",
      );
      expect(seen).toHaveLength(1);
    } finally {
      lease.release();
    }
  });

  test("streams the answer as it arrives", async () => {
    const lease = leaseClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: "real" });
    try {
      const response = await fetch(`${lease.env.ANTHROPIC_BASE_URL}/stream`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.env.CLAUDE_CODE_OAUTH_TOKEN}`,
        },
        body: "{}",
      });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      // The first event arrives while the upstream response is still open.
      const first = await reader.read();
      expect(decoder.decode(first.value)).toBe("event: first\n\n");
      releaseStream!();
      let rest = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        rest += decoder.decode(chunk.value);
      }
      expect(rest).toBe("event: second\n\n");
    } finally {
      lease.release();
    }
  });

  test("passes a compressed answer through intact", async () => {
    const lease = leaseClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: "real" });
    try {
      const response = await fetch(`${lease.env.ANTHROPIC_BASE_URL}/gzip`, {
        headers: {
          authorization: `Bearer ${lease.env.CLAUDE_CODE_OAUTH_TOKEN}`,
          "accept-encoding": "gzip",
        },
      });
      expect(await response.json()).toEqual({ zipped: true });
    } finally {
      lease.release();
    }
  });

  test("answers 502 when the upstream cannot be reached", async () => {
    const lease = leaseClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: "real" });
    const undo = __setClaudeTokenProxyUpstreamForTest("http://127.0.0.1:1");
    try {
      const response = await fetch(
        `${lease.env.ANTHROPIC_BASE_URL}/v1/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${lease.env.CLAUDE_CODE_OAUTH_TOKEN}`,
          },
          body: "{}",
        },
      );
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("Could not reach Anthropic");
      expect(body).not.toContain("real");
    } finally {
      undo();
      lease.release();
    }
  });

  test("refuses to lease when there is no credential", () => {
    expect(() => leaseClaudeToken({})).toThrow(/No Claude credential/);
  });
});
