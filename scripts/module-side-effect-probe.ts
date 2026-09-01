#!/usr/bin/env bun
/**
 * The child half of scripts/check-module-side-effects.ts — read that file
 * first; it explains the hazard and the exemption.
 *
 * Runs in its own process because the instrumentation has to be in place
 * before the first server module is evaluated. Every resource-creating global
 * is replaced with a recording stub, so a violation is only ever RECORDED,
 * never created: no socket is bound, no ticker armed, no subprocess spawned,
 * whatever the imported code tries to do.
 *
 * argv: <modules.json> <result.json>
 */

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

interface Hit {
  kind: string;
  module: string;
  frame: string;
}

const hits: Hit[] = [];
let current = "(before any import)";

/** The first stack frame inside the repo that is not this probe — i.e. the
 *  line that actually asked for the resource, which is usually in a different
 *  file from the module being imported. */
function frameOf(): string {
  const lines = (new Error().stack || "").split("\n").slice(2);
  for (const l of lines) {
    const m = l.match(/\((\/[^)]+)\)/) || l.match(/at (\/\S+)/);
    if (!m) continue;
    const file = m[1];
    if (file.includes("/node_modules/")) continue;
    if (file.includes("module-side-effect-probe.ts")) continue;
    return file.startsWith(`${REPO_ROOT}/`)
      ? file.slice(REPO_ROOT.length + 1)
      : file;
  }
  return lines[0]?.trim() || "(unknown frame)";
}

function record(kind: string): void {
  hits.push({ kind, module: current, frame: frameOf() });
}

const timerStub = {
  unref() {
    return timerStub;
  },
  ref() {
    return timerStub;
  },
  hasRef() {
    return false;
  },
  refresh() {
    return timerStub;
  },
  close() {},
  [Symbol.toPrimitive]() {
    return 0;
  },
};
(globalThis as any).setInterval = (..._a: unknown[]) => {
  record("setInterval");
  return timerStub as never;
};
(globalThis as any).setTimeout = (..._a: unknown[]) => {
  record("setTimeout");
  return timerStub as never;
};
(globalThis as any).setImmediate = (..._a: unknown[]) => {
  record("setImmediate");
  return timerStub as never;
};

const serverStub = {
  stop() {},
  reload() {},
  unref() {},
  ref() {},
  port: 0,
  hostname: "127.0.0.1",
  url: new URL("http://127.0.0.1:0"),
  pendingRequests: 0,
  pendingWebSockets: 0,
};
(Bun as any).serve = (..._a: unknown[]) => {
  record("Bun.serve");
  return serverStub as never;
};
(Bun as any).listen = (..._a: unknown[]) => {
  record("Bun.listen");
  return { stop() {}, unref() {}, ref() {} } as never;
};
(Bun as any).connect = (..._a: unknown[]) => {
  record("Bun.connect");
  return Promise.reject(new Error("side-effect probe: no real connections"));
};
(Bun as any).spawn = (..._a: unknown[]) => {
  record("Bun.spawn");
  throw new Error("side-effect probe: no subprocess at import time");
};
(Bun as any).spawnSync = (..._a: unknown[]) => {
  record("Bun.spawnSync");
  return {
    exitCode: 0,
    success: true,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  } as never;
};

const [, , listPath, outPath] = process.argv;
const modules: string[] = await Bun.file(listPath).json();
const failed: { module: string; error: string }[] = [];

for (const m of modules) {
  current = m;
  try {
    // Repo-relative normally; absolute lets the guard's own test point the
    // probe at a throwaway violating fixture outside the tree.
    await import(m.startsWith("/") ? m : `${REPO_ROOT}/${m}`);
  } catch (e) {
    failed.push({
      module: m,
      error: String((e as Error)?.message || e).slice(0, 300),
    });
  }
}

await Bun.write(
  outPath,
  JSON.stringify({ scanned: modules.length, hits, failed }),
);
// Hard exit: a module we imported may have left something pending, and this
// probe's verdict is already written.
process.exit(0);
