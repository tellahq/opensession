// Submits every bun.lock's full dependency tree to GitHub's dependency
// submission API. The dependency graph cannot parse bun.lock, so without this
// snapshot Dependabot alerts only see direct dependencies via package.json
// manifests — transitive vulnerabilities in the bun workspaces would be
// invisible.
//
// No dependencies; runs on plain Node. Usage:
//   node scripts/submit-bun-dependencies.mjs            # submit
//   DRY_RUN=1 node scripts/submit-bun-dependencies.mjs  # parse + print summary
import { readFileSync } from "node:fs";

const LOCKFILES = process.env.BUN_LOCK
  ? [process.env.BUN_LOCK]
  : ["bun.lock", "packages/clients/mac/bun.lock"];

const purl = (name, version) =>
  `pkg:npm/${name.replace("@", "%40")}@${version}`;

function parseLockfile(lockPath) {
  // bun.lock is JSONC-with-trailing-commas; the generated file contains no
  // comments, so stripping trailing commas is sufficient.
  const lock = JSON.parse(
    readFileSync(lockPath, "utf8").replace(/,(\s*[}\]])/g, "$1"),
  );

  const directRuntime = new Set();
  const directDev = new Set();
  for (const ws of Object.values(lock.workspaces ?? {})) {
    for (const name of Object.keys(ws.dependencies ?? {}))
      directRuntime.add(name);
    for (const name of Object.keys(ws.optionalDependencies ?? {}))
      directRuntime.add(name);
    for (const name of Object.keys(ws.devDependencies ?? {}))
      directDev.add(name);
  }

  // Scope must propagate through the tree: a transitive pulled in only by
  // devDependencies is development-scoped, and runtime reachability wins when
  // a package is reachable both ways.
  const depsByName = new Map();
  const entries = [];
  let skipped = 0;
  for (const entry of Object.values(lock.packages ?? {})) {
    const resolution = entry[0];
    const at = resolution.lastIndexOf("@");
    if (at <= 0) {
      skipped++;
      continue;
    }
    const name = resolution.slice(0, at);
    const version = resolution.slice(at + 1);
    // Skip non-registry resolutions (workspace:, file:, git) — no meaningful purl.
    if (!/^\d/.test(version)) {
      skipped++;
      continue;
    }
    const meta = entry[2] ?? {};
    const edges = [
      ...Object.keys(meta.dependencies ?? {}),
      ...Object.keys(meta.optionalDependencies ?? {}),
      ...Object.keys(meta.peerDependencies ?? {}),
    ];
    if (!depsByName.has(name)) depsByName.set(name, edges);
    entries.push({ name, version });
  }

  const reachableFrom = (roots) => {
    const seen = new Set();
    const stack = [...roots];
    while (stack.length) {
      const name = stack.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      for (const dep of depsByName.get(name) ?? []) stack.push(dep);
    }
    return seen;
  };
  const runtimeReachable = reachableFrom(directRuntime);
  const devReachable = reachableFrom(directDev);

  const resolved = {};
  for (const { name, version } of entries) {
    const id = purl(name, version);
    if (resolved[id]) continue;
    resolved[id] = {
      package_url: id,
      relationship:
        directRuntime.has(name) || directDev.has(name) ? "direct" : "indirect",
      scope:
        !runtimeReachable.has(name) && devReachable.has(name)
          ? "development"
          : "runtime",
    };
  }
  return { resolved, skipped };
}

const manifests = {};
for (const lockPath of LOCKFILES) {
  const { resolved, skipped } = parseLockfile(lockPath);
  manifests[lockPath] = {
    name: lockPath,
    file: { source_location: lockPath },
    resolved,
  };
  console.log(
    `parsed ${Object.keys(resolved).length} packages from ${lockPath} (${skipped} non-registry entries skipped)`,
  );
}

const snapshot = {
  // Epoch millis, NOT the run id: for a given correlator the API discards any
  // snapshot whose version is below the stored high-water mark, and run ids
  // sit orders of magnitude above wall-clock scales — one run-id submission
  // would silently invalidate every later manual run.
  version: Date.now(),
  sha: process.env.GITHUB_SHA,
  ref: process.env.GITHUB_REF,
  job: {
    correlator: "bun-dependency-submission",
    id: process.env.GITHUB_RUN_ID ?? "manual",
  },
  detector: {
    name: "bun-lock-submission",
    version: "2.0.0",
    url: "https://github.com/tellahq/opensession",
  },
  scanned: new Date().toISOString(),
  manifests,
};

if (process.env.DRY_RUN) {
  const total = Object.values(manifests).reduce(
    (n, m) => n + Object.keys(m.resolved).length,
    0,
  );
  const dev = Object.values(manifests)
    .flatMap((m) => Object.values(m.resolved))
    .filter((r) => r.scope === "development").length;
  console.log(
    `DRY_RUN: ${total} packages across ${Object.keys(manifests).length} manifests (${dev} development-scoped)`,
  );
  process.exit(0);
}

const repo = process.env.GITHUB_REPOSITORY;
const res = await fetch(
  `https://api.github.com/repos/${repo}/dependency-graph/snapshots`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify(snapshot),
  },
);
const body = await res.json();
console.log(res.status, JSON.stringify(body));
if (!res.ok) process.exit(1);
