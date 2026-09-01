#!/usr/bin/env bun
/** Generate deterministic SPDX and human-readable license inventories from bun.lock. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface LockEntry {
  0: string;
  2?: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  3?: string;
}

interface PackageRecord {
  name: string;
  version: string;
  integrity?: string;
  license: string;
}

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseLock(lockPath: string): any {
  return JSON.parse(
    readFileSync(lockPath, "utf8").replace(/,(\s*[}\]])/g, "$1"),
  );
}

function runtimePackageNames(lock: any, includeDev: boolean): Set<string> {
  const roots = new Set<string>();
  for (const workspace of Object.values(lock.workspaces ?? {}) as any[]) {
    for (const name of Object.keys(workspace.dependencies ?? {}))
      roots.add(name);
    for (const name of Object.keys(workspace.optionalDependencies ?? {}))
      roots.add(name);
    if (includeDev) {
      for (const name of Object.keys(workspace.devDependencies ?? {}))
        roots.add(name);
    }
  }
  const edges = new Map<string, Set<string>>();
  for (const entry of Object.values(lock.packages ?? {}) as LockEntry[]) {
    const resolution = entry[0];
    const at = resolution.lastIndexOf("@");
    if (at <= 0) continue;
    const name = resolution.slice(0, at);
    const meta = entry[2] ?? {};
    const current = edges.get(name) ?? new Set<string>();
    for (const group of [
      meta.dependencies,
      meta.optionalDependencies,
      meta.peerDependencies,
    ]) {
      for (const dependency of Object.keys(group ?? {}))
        current.add(dependency);
    }
    edges.set(name, current);
  }
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    pending.push(...(edges.get(name) ?? []));
  }
  return reachable;
}

function packageMetadata(nodeModules: string): Map<string, string> {
  const licenses = new Map<string, string>();
  const visit = (directory: string, depth: number) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const manifest = join(path, "package.json");
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, "utf8"));
          if (typeof pkg.name === "string" && typeof pkg.version === "string") {
            const raw =
              typeof pkg.license === "string"
                ? pkg.license
                : Array.isArray(pkg.licenses)
                  ? pkg.licenses
                      .map((item: any) =>
                        typeof item === "string" ? item : item?.type,
                      )
                      .filter(Boolean)
                      .join(" OR ")
                  : "";
            if (raw) licenses.set(`${pkg.name}@${pkg.version}`, raw);
          }
        } catch {}
      }
      // Bun's content-addressed store nests the real package below node_modules.
      if (entry.name === ".bin") continue;
      visit(path, depth + 1);
    }
  };
  visit(nodeModules, 0);
  return licenses;
}

const LICENSE_ALIASES: Record<string, string> = {
  "Apache 2.0": "Apache-2.0",
  "Apache-2": "Apache-2.0",
  BSD: "BSD-3-Clause",
  "GPL-2.0": "GPL-2.0-only",
  "LGPL-3.0": "LGPL-3.0-only",
  "MIT License": "MIT",
};

export function spdxLicense(raw: string | undefined): string {
  if (!raw) return "NOASSERTION";
  const value = LICENSE_ALIASES[raw] ?? raw.replace(/^\((.*)\)$/, "$1");
  // Keep valid-looking SPDX expressions. Free-form prose belongs in neither
  // licenseDeclared nor an installer decision.
  return /^[A-Za-z0-9.+-]+(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$/.test(
    value,
  )
    ? value
    : "NOASSERTION";
}

function sha512Checksum(
  integrity: string | undefined,
): { algorithm: string; checksumValue: string }[] | undefined {
  if (!integrity?.startsWith("sha512-")) return undefined;
  return [
    {
      algorithm: "SHA512",
      checksumValue: Buffer.from(integrity.slice(7), "base64").toString("hex"),
    },
  ];
}

export function generateReleaseMetadata(options: {
  lockPath: string;
  nodeModules: string;
  outDir: string;
  name: string;
  version: string;
  includeDev?: boolean;
}): { packageCount: number } {
  const lockText = readFileSync(options.lockPath, "utf8");
  const lock = parseLock(options.lockPath);
  const reachable = runtimePackageNames(lock, options.includeDev ?? false);
  const licenses = packageMetadata(options.nodeModules);
  const packages = new Map<string, PackageRecord>();

  for (const entry of Object.values(lock.packages ?? {}) as LockEntry[]) {
    const resolution = entry[0];
    const at = resolution.lastIndexOf("@");
    if (at <= 0) continue;
    const name = resolution.slice(0, at);
    const version = resolution.slice(at + 1);
    if (!reachable.has(name) || !/^\d/.test(version)) continue;
    const key = `${name}@${version}`;
    packages.set(key, {
      name,
      version,
      integrity: entry[3],
      license: spdxLicense(licenses.get(key)),
    });
  }

  const records = [...packages.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const lockDigest = createHash("sha256").update(lockText).digest("hex");
  const rootId = "SPDXRef-OpenSession";
  const spdxPackages = records.map((pkg, index) => ({
    SPDXID: `SPDXRef-Package-${index + 1}`,
    name: pkg.name,
    versionInfo: pkg.version,
    downloadLocation: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/").pop()}-${pkg.version}.tgz`,
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: pkg.license,
    copyrightText: "NOASSERTION",
    ...(sha512Checksum(pkg.integrity)
      ? { checksums: sha512Checksum(pkg.integrity) }
      : {}),
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:npm/${pkg.name.replace("@", "%40")}@${pkg.version}`,
      },
    ],
  }));
  const created = new Date(
    Number(process.env.SOURCE_DATE_EPOCH ?? "0") * 1000,
  ).toISOString();
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${options.name}-${options.version}`,
    documentNamespace: `https://github.com/tellahq/opensession/sbom/${lockDigest}`,
    creationInfo: {
      created,
      creators: ["Tool: opensession-generate-release-metadata/1.0"],
    },
    packages: [
      {
        SPDXID: rootId,
        name: options.name,
        versionInfo: options.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "MIT",
        licenseDeclared: "MIT",
        copyrightText: "Copyright Open Session contributors",
      },
      ...spdxPackages,
    ],
    documentDescribes: [rootId],
    relationships: spdxPackages.map((pkg) => ({
      spdxElementId: rootId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: pkg.SPDXID,
    })),
  };

  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(
    join(options.outDir, "SBOM.spdx.json"),
    JSON.stringify(sbom, null, 2) + "\n",
  );
  const inventory = [
    `# Runtime package license inventory for ${options.name} ${options.version}`,
    "# Generated from bun.lock. See THIRD-PARTY-NOTICES.md for bundled native and font components.",
    "name\tversion\tdeclared license\tpackage URL",
    ...records.map(
      (pkg) =>
        `${pkg.name}\t${pkg.version}\t${pkg.license}\tpkg:npm/${pkg.name.replace("@", "%40")}@${pkg.version}`,
    ),
    "",
  ].join("\n");
  writeFileSync(join(options.outDir, "THIRD-PARTY-PACKAGES.txt"), inventory);
  return { packageCount: records.length };
}

if (import.meta.main) {
  const lockPath = resolve(option("lock", "bun.lock")!);
  const nodeModules = resolve(
    option("node-modules", join(dirname(lockPath), "node_modules"))!,
  );
  const outDir = resolve(option("out", ".release-metadata")!);
  const name = option("name", basename(dirname(lockPath)))!;
  const version = option("version", "unknown")!;
  const includeDev = process.argv.includes("--include-dev");
  if (!existsSync(lockPath)) throw new Error(`lockfile not found: ${lockPath}`);
  if (!existsSync(nodeModules) || !statSync(nodeModules).isDirectory())
    throw new Error(`node_modules not found: ${nodeModules}`);
  const result = generateReleaseMetadata({
    lockPath,
    nodeModules,
    outDir,
    name,
    version,
    includeDev,
  });
  console.log(
    `wrote SPDX SBOM and license inventory for ${result.packageCount} runtime packages to ${outDir}`,
  );
}
