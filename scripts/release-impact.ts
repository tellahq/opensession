#!/usr/bin/env bun

import {
  isFrontendOnlyRelease,
  requiresRootDeploy,
} from "../packages/core/opensession-server/src/server/self-deploy";

export type ReleaseImpact =
  | "frontend-only"
  | "gateway-handoff"
  | "supervisor-restart"
  | "coordinated"
  | "coordinated-supervisor-restart"
  | "root";

const ENTRIES = {
  gateway: "packages/core/opensession-server/opensession.ts",
  supervisor:
    "packages/core/opensession-server/src/server/gateway-supervisor.ts",
  kernel: "packages/core/opensession-server/src/session-kernel-service.ts",
  executor: "packages/core/opensession-server/src/executor/main.ts",
} as const;

export async function changedPaths(
  checkout: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const process = Bun.spawn(
    [
      "git",
      "-C",
      checkout,
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      fromSha,
      toSha,
      "--",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`git diff failed: ${stderr.trim()}`);
  return new TextDecoder().decode(stdout).split("\0").filter(Boolean);
}

async function importClosure(
  root: string,
  entry: string,
): Promise<Set<string>> {
  const result = await Bun.build({
    root,
    entrypoints: [entry],
    target: "bun",
    packages: "external",
    metafile: true,
  });
  if (!result.success || !result.metafile) {
    throw new Error(
      `dependency graph failed for ${entry}: ${result.logs.map((log) => log.message).join("; ")}`,
    );
  }
  return new Set(Object.keys(result.metafile.inputs));
}

async function combinedClosure(
  fromRoot: string,
  toRoot: string,
  entry: string,
): Promise<Set<string>> {
  const [before, after] = await Promise.all([
    importClosure(fromRoot, entry),
    importClosure(toRoot, entry),
  ]);
  return new Set([...before, ...after]);
}

export type RuntimeComponents = {
  gateway: boolean;
  supervisor: boolean;
  kernel: boolean;
  executor: boolean;
};

export function classifyRuntimeComponents(
  runtimePaths: string[],
  closures: {
    gateway: Set<string>;
    supervisor: Set<string>;
    kernel: Set<string>;
    executor: Set<string>;
  },
): RuntimeComponents {
  const components: RuntimeComponents = {
    gateway: runtimePaths.length > 0,
    supervisor: runtimePaths.some((path) => closures.supervisor.has(path)),
    kernel: false,
    executor: false,
  };
  for (const path of runtimePaths) {
    if (
      path === "package.json" ||
      path === "bun.lock" ||
      path.startsWith("packages/core/protocol/")
    ) {
      components.kernel = true;
      components.executor = true;
      continue;
    }
    const known =
      closures.gateway.has(path) ||
      closures.supervisor.has(path) ||
      closures.kernel.has(path) ||
      closures.executor.has(path);
    components.kernel ||= closures.kernel.has(path);
    components.executor ||= closures.executor.has(path);
    if (!known) {
      // Unknown runtime ownership stays fail-closed.
      components.kernel = true;
      components.executor = true;
    }
  }
  return components;
}

export function classifyRuntimeImpact(
  runtimePaths: string[],
  closures: {
    gateway: Set<string>;
    supervisor: Set<string>;
    kernel: Set<string>;
    executor: Set<string>;
  },
):
  | "gateway-handoff"
  | "supervisor-restart"
  | "coordinated"
  | "coordinated-supervisor-restart" {
  const components = classifyRuntimeComponents(runtimePaths, closures);
  if (components.kernel || components.executor) {
    return components.supervisor
      ? "coordinated-supervisor-restart"
      : "coordinated";
  }
  return components.supervisor ? "supervisor-restart" : "gateway-handoff";
}

export function releaseRuntimePaths(paths: string[]): string[] {
  const deploySupportPaths = new Set([
    "scripts/deploy-canary.ts",
    "scripts/release-impact.ts",
    "scripts/validate-frontend-build.ts",
  ]);
  return paths.filter(
    (path) =>
      path !== "AGENTS.md" &&
      !path.startsWith("docs/") &&
      !path.endsWith(".test.ts") &&
      !path.endsWith(".spec.ts") &&
      !deploySupportPaths.has(path) &&
      !path.startsWith("packages/core/opensession-server/src/frontend/"),
  );
}

export async function classifyReleaseImpact(options: {
  fromRoot: string;
  toRoot: string;
  checkout: string;
  fromSha: string;
  toSha: string;
}): Promise<{
  impact: ReleaseImpact;
  paths: string[];
  closures: Record<string, number>;
  components?: RuntimeComponents;
}> {
  const paths = await changedPaths(
    options.checkout,
    options.fromSha,
    options.toSha,
  );
  if (requiresRootDeploy(paths)) return { impact: "root", paths, closures: {} };
  if (isFrontendOnlyRelease(paths))
    return { impact: "frontend-only", paths, closures: {} };

  const runtimePaths = releaseRuntimePaths(paths);
  // Non-runtime support files still need `current` to advance, but no protocol
  // peer changed. The shell controller handles this as a cheap gateway handoff;
  // true frontend-only releases were returned above and are promoted in-process.
  if (runtimePaths.length === 0) {
    return {
      impact: "gateway-handoff",
      paths,
      closures: {},
      components: {
        gateway: true,
        supervisor: false,
        kernel: false,
        executor: false,
      },
    };
  }

  const [gateway, supervisor, kernel, executor] = await Promise.all([
    combinedClosure(options.fromRoot, options.toRoot, ENTRIES.gateway),
    combinedClosure(options.fromRoot, options.toRoot, ENTRIES.supervisor),
    combinedClosure(options.fromRoot, options.toRoot, ENTRIES.kernel),
    combinedClosure(options.fromRoot, options.toRoot, ENTRIES.executor),
  ]);
  const closureSizes = {
    gateway: gateway.size,
    supervisor: supervisor.size,
    kernel: kernel.size,
    executor: executor.size,
  };
  const components = classifyRuntimeComponents(runtimePaths, {
    gateway,
    supervisor,
    kernel,
    executor,
  });
  return {
    impact: classifyRuntimeImpact(runtimePaths, {
      gateway,
      supervisor,
      kernel,
      executor,
    }),
    paths,
    closures: closureSizes,
    components,
  };
}

if (import.meta.main) {
  const [fromRoot, toRoot, checkout, fromSha, toSha] = process.argv.slice(2);
  if (
    !fromRoot ||
    !toRoot ||
    !checkout ||
    !/^[0-9a-f]{40,64}$/.test(fromSha || "") ||
    !/^[0-9a-f]{40,64}$/.test(toSha || "")
  ) {
    console.error(
      "usage: release-impact.ts <from-release> <to-release> <checkout> <from-sha> <to-sha>",
    );
    process.exit(2);
  }
  const result = await classifyReleaseImpact({
    fromRoot,
    toRoot,
    checkout,
    fromSha,
    toSha,
  });
  const manifest = process.env.OPENSESSION_RELEASE_IMPACT_MANIFEST;
  if (manifest)
    await Bun.write(
      manifest,
      `${JSON.stringify({ ...result, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  console.log(result.impact);
}
