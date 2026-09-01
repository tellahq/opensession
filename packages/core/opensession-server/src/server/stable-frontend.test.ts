import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStableFrontendResponder,
  publishStableFrontendSnapshot,
  stableFrontendHttpResponse,
} from "./stable-frontend";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const state = mkdtempSync(join(tmpdir(), "stable-frontend-"));
  roots.push(state);
  const sha = "a".repeat(40);
  const releaseRoot = join(state, "releases", sha);
  mkdirSync(join(releaseRoot, ".frontend-dist"), { recursive: true });
  writeFileSync(join(releaseRoot, ".opensession-release"), `${sha}\n`);
  writeFileSync(
    join(releaseRoot, ".frontend-dist", "App-hash.js"),
    "window.loaded = true;",
  );
  publishStableFrontendSnapshot(state, {
    releaseRoot,
    version: "App-hash.js|styles.css",
    indexHtml: '<!doctype html><script src="/App-hash.js"></script>',
  });
  return { state, releaseRoot };
}

function request(
  path: string,
  accept = "text/html",
  userAgent = "OS1 test browser",
): Buffer {
  return Buffer.from(
    `GET ${path} HTTP/1.1\r\nHost: os.test\r\nAccept: ${accept}\r\nUser-Agent: ${userAgent}\r\n\r\n`,
  );
}

function body(response: Buffer): string {
  return response.toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
}

describe("stable frontend ingress", () => {
  test("serves the last rendered SPA and immutable assets without a gateway", () => {
    const { state } = fixture();
    const page = stableFrontendHttpResponse(state, request("/workspace/demo"));
    expect(page?.toString()).toContain("HTTP/1.1 200 OK");
    expect(body(page!)).toContain("App-hash.js");

    const asset = stableFrontendHttpResponse(
      state,
      request("/App-hash.js", "*/*"),
    );
    expect(asset?.toString()).toContain(
      "Cache-Control: public, max-age=31536000, immutable",
    );
    expect(body(asset!)).toBe("window.loaded = true;");
  });

  test("serves HEAD metadata without reading an asset body into the response", () => {
    const { state } = fixture();
    const result = stableFrontendHttpResponse(
      state,
      Buffer.from(
        "HEAD /App-hash.js HTTP/1.1\r\nHost: os.test\r\nAccept: */*\r\n\r\n",
      ),
    );
    expect(result?.toString()).toContain("Content-Length: 21");
    expect(body(result!)).toBe("");
  });

  test("refreshes an atomically published shell and drops the previous asset cache", () => {
    const { state } = fixture();
    const respond = createStableFrontendResponder(state, { snapshotTtlMs: 0 });
    expect(body(respond(request("/workspace/demo"))!)).toContain("App-hash.js");

    const sha = "b".repeat(40);
    const releaseRoot = join(state, "releases", sha);
    mkdirSync(join(releaseRoot, ".frontend-dist"), { recursive: true });
    writeFileSync(join(releaseRoot, ".opensession-release"), `${sha}\n`);
    writeFileSync(
      join(releaseRoot, ".frontend-dist", "App-next.js"),
      "window.next = true;",
    );
    publishStableFrontendSnapshot(state, {
      releaseRoot,
      version: "App-next.js|styles.css",
      indexHtml: '<!doctype html><script src="/App-next.js"></script>',
    });

    expect(body(respond(request("/workspace/demo"))!)).toContain("App-next.js");
    expect(body(respond(request("/App-hash.js", "*/*"))!)).toBe(
      "window.loaded = true;",
    );
    expect(body(respond(request("/App-next.js", "*/*"))!)).toBe(
      "window.next = true;",
    );
  });

  test("carries old lazy chunks through consecutive release snapshots", () => {
    const { state, releaseRoot: firstRoot } = fixture();
    const respond = createStableFrontendResponder(state, { snapshotTtlMs: 0 });

    const secondSha = "b".repeat(40);
    const secondRoot = join(state, "releases", secondSha);
    mkdirSync(join(secondRoot, ".frontend-dist"), { recursive: true });
    writeFileSync(join(secondRoot, ".opensession-release"), `${secondSha}\n`);
    writeFileSync(
      join(secondRoot, ".frontend-dist", "Settings-next.js"),
      "window.settings = true;",
    );
    publishStableFrontendSnapshot(state, {
      releaseRoot: secondRoot,
      version: "App-next.js|styles.css",
      indexHtml: '<script src="/App-next.js"></script>',
    });

    const snapshot = JSON.parse(
      readFileSync(join(state, "stable-frontend.json"), "utf8"),
    );
    expect(snapshot.fallbackRoots).toEqual([firstRoot]);
    expect(body(respond(request("/App-hash.js", "*/*"))!)).toBe(
      "window.loaded = true;",
    );
  });

  test("owns liveness, publishes ingress telemetry, and leaves APIs to the backend", () => {
    const { state } = fixture();
    const respond = createStableFrontendResponder(state, {
      liveStatus: () => ({
        backendSelected: true,
        proxy: { pending: 2, rejected: 1 },
      }),
    });
    expect(JSON.parse(body(respond(request("/live", "*/*"))!))).toMatchObject({
      ok: true,
      phase: "handoff",
      backendReady: false,
      backendSelected: true,
      proxy: { pending: 2, rejected: 1 },
    });
    expect(
      stableFrontendHttpResponse(state, request("/ready", "*/*")),
    ).toBeNull();
    expect(
      stableFrontendHttpResponse(
        state,
        request("/api/sessions", "application/json"),
      ),
    ).toBeNull();
    expect(
      stableFrontendHttpResponse(state, request("/../secret.js", "*/*")),
    ).toBeNull();
    expect(
      stableFrontendHttpResponse(
        state,
        request(
          "/session/social-preview",
          "text/html",
          "Slackbot-LinkExpanding 1.0",
        ),
      ),
    ).toBeNull();
    expect(
      stableFrontendHttpResponse(
        state,
        Buffer.from("POST /workspace HTTP/1.1\r\nHost: os.test\r\n\r\n"),
      ),
    ).toBeNull();
  });
});
