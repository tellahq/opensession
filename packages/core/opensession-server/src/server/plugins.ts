/**
 * Installable packages: the manifest, its validator, and the ledger of what
 * is installed.
 *
 * A package is a git repository with `opensession-plugin.json` at its root,
 * bundling any of four things this instance already knows how to store: MCP
 * server entries, feed descriptors, automation recipes, and skill
 * directories. Nothing here loads or evaluates code from a package, by
 * design; see adrs/publishable-packages.md for why that line is where it is.
 *
 * This module is deliberately the DATA half: types, a pure validator, and a
 * JSON ledger. The fetching, planning and applying live in
 * scripts/lib/plugins.ts beside the CLI, because they need git and the
 * config-seed writer that the CLI already owns.
 *
 * Two properties the validator exists to guarantee, both of which the ADR
 * leans on:
 *
 *   1. A package repository is publishable by construction. Every value in an
 *      MCP server's `env` and `headers` must be a bare `${NAME}` reference,
 *      and a server URL may carry neither a query string nor userinfo, so
 *      there is nowhere in the format to put a credential.
 *   2. A package proposes, it does not decide. `allowedUsers` is the
 *      installing operator's call, automations install disabled, and
 *      `selfImprove` is refused outright.
 *
 * The ledger resolves its path per call rather than at module load: the state
 * dir is read from the environment at call time (src/server/paths.ts), and a
 * pinned module-level path is how a test ends up writing to the live store.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { statePath } from "./paths";

/** The manifest file a package repository must carry at its root. */
export const PACKAGE_MANIFEST_FILE = "opensession-plugin.json";

/** The GitHub topic a published package is expected to carry. */
export const PACKAGE_TOPIC = "opensession-plugin";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,40}$/;
/** A credential reference and nothing else: no prefix, no suffix, no literal. */
const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export interface PackageMcpServer {
  type?: "http" | "sse";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface PackageAutomation {
  id: string;
  label?: string;
  description?: string;
  /** Integration ids that must be enabled for this to do anything. */
  requires?: string[];
  automation: {
    name: string;
    prompt: string;
    eventKey?: string;
    schedule?: string;
    mode?: "ask" | "code";
    mcpServers?: string[];
    prReviewer?: string;
    [key: string]: unknown;
  };
}

/**
 * A feed descriptor, shaped exactly like the feeds store's own `ConfigFeed`.
 * Kept loose here on purpose: `upsertConfigFeed` validates it authoritatively
 * at install time, and a second full schema in this file would drift from it.
 */
export interface PackageFeed {
  id: string;
  title: string;
  refKind?: string;
  mcpServers?: string[];
  items: { server: string; tool: string; map: { id: string; title: string } };
  [key: string]: unknown;
}

export interface PackageManifest {
  name: string;
  version: string;
  description: string;
  homepage?: string;
  /** Integration ids that must be enabled for the package to be useful. */
  requires?: string[];
  mcpServers?: Record<string, PackageMcpServer>;
  feeds?: PackageFeed[];
  automations?: PackageAutomation[];
  /** Repo-relative directories, each containing a SKILL.md. */
  skills?: string[];
}

export type ManifestResult =
  | { manifest: PackageManifest }
  | { errors: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Every value in a credential block must be a reference, never a literal. */
function checkRefs(block: unknown, label: string, errors: string[]): void {
  if (block === undefined) return;
  if (!isObject(block)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(block)) {
    if (typeof value !== "string" || !ENV_REF.test(value)) {
      errors.push(
        `${label}.${key} must be a \${NAME} reference, not a value. Packages never carry secrets`,
      );
    }
  }
}

function validateServer(name: string, input: unknown, errors: string[]): void {
  if (!SLUG.test(name)) {
    errors.push(`mcpServers.${name}: name must be a short slug`);
    return;
  }
  if (!isObject(input)) {
    errors.push(`mcpServers.${name} must be an object`);
    return;
  }
  if ("allowedUsers" in input) {
    errors.push(
      `mcpServers.${name}: allowedUsers is the installing operator's call, set with \`--users\``,
    );
  }
  const url = input.url;
  const command = input.command;
  if (url !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(String(url));
    } catch {
      errors.push(`mcpServers.${name}: invalid url`);
    }
    if (parsed) {
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        errors.push(`mcpServers.${name}: url must be http(s)`);
      }
      // A token hides in a query string long after the headers look clean.
      if (parsed.search) {
        errors.push(
          `mcpServers.${name}: url must carry no query string. Pass credentials as a \${NAME} header`,
        );
      }
      if (parsed.username || parsed.password) {
        errors.push(`mcpServers.${name}: url must carry no userinfo`);
      }
    }
  } else if (typeof command === "string" && command.trim()) {
    if (input.args !== undefined && !Array.isArray(input.args)) {
      errors.push(`mcpServers.${name}: args must be an array`);
    }
  } else {
    errors.push(`mcpServers.${name}: needs a url (http) or a command (stdio)`);
  }
  checkRefs(input.env, `mcpServers.${name}.env`, errors);
  checkRefs(input.headers, `mcpServers.${name}.headers`, errors);
}

function validateAutomation(
  entry: unknown,
  index: number,
  errors: string[],
): void {
  const where = `automations[${index}]`;
  if (!isObject(entry)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (typeof entry.id !== "string" || !SLUG.test(entry.id)) {
    errors.push(`${where}.id must be a short slug`);
  }
  const automation = entry.automation;
  if (!isObject(automation)) {
    errors.push(`${where}.automation is required`);
    return;
  }
  if (typeof automation.name !== "string" || !automation.name.trim()) {
    errors.push(`${where}.automation.name is required`);
  }
  if (typeof automation.prompt !== "string" || !automation.prompt.trim()) {
    errors.push(`${where}.automation.prompt is required`);
  }
  // A package proposes a job; the operator starts it.
  if (automation.enabled === true) {
    errors.push(
      `${where}.automation.enabled: a package cannot enable its own automation`,
    );
  }
  if (automation.selfImprove) {
    errors.push(
      `${where}.automation.selfImprove: a package cannot ship a self-editing automation`,
    );
  }
}

function validateFeed(entry: unknown, index: number, errors: string[]): void {
  const where = `feeds[${index}]`;
  if (!isObject(entry)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (typeof entry.id !== "string" || !SLUG.test(entry.id)) {
    errors.push(`${where}.id must be a short slug`);
  }
  if (typeof entry.title !== "string" || !entry.title.trim()) {
    errors.push(`${where}.title is required`);
  }
  const items = entry.items;
  if (!isObject(items)) {
    errors.push(`${where}.items is required`);
    return;
  }
  if (typeof items.server !== "string" || !items.server.trim()) {
    errors.push(`${where}.items.server is required`);
  }
  if (typeof items.tool !== "string" || !items.tool.trim()) {
    errors.push(`${where}.items.tool is required`);
  }
  const map = items.map;
  if (
    !isObject(map) ||
    typeof map.id !== "string" ||
    typeof map.title !== "string"
  ) {
    errors.push(`${where}.items.map needs id and title`);
  }
}

/** A skill path must stay inside the checkout and name a directory. */
export function skillPathError(path: unknown): string | undefined {
  if (typeof path !== "string" || !path.trim())
    return "must be a non-empty path";
  if (path.startsWith("/")) return "must be relative to the package root";
  if (path.split("/").some((part) => part === ".." || part === ".")) {
    return "must not contain . or ..";
  }
  if (path.includes("\\")) return "must use forward slashes";
  return undefined;
}

/** The directory name an installed skill takes: the last path segment. */
export function skillName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * Validate a parsed manifest. Pure: no filesystem, no instance state. The
 * instance-aware half (does this name collide with something already here)
 * belongs to the install plan, not here.
 */
export function validateManifest(input: unknown): ManifestResult {
  const errors: string[] = [];
  if (!isObject(input)) return { errors: ["manifest must be a JSON object"] };

  const name = input.name;
  if (typeof name !== "string" || !SLUG.test(name)) {
    errors.push("name must be a short slug (a-z, 0-9, dash, underscore)");
  }
  if (
    typeof input.version !== "string" ||
    !/^\d+\.\d+\.\d+/.test(input.version)
  ) {
    errors.push("version must look like 1.0.0");
  }
  if (typeof input.description !== "string" || !input.description.trim()) {
    errors.push("description is required");
  }
  if (input.requires !== undefined && !Array.isArray(input.requires)) {
    errors.push("requires must be an array of integration ids");
  }

  if (input.mcpServers !== undefined) {
    if (!isObject(input.mcpServers))
      errors.push("mcpServers must be an object");
    else {
      for (const [server, cfg] of Object.entries(input.mcpServers)) {
        validateServer(server, cfg, errors);
      }
    }
  }
  if (input.feeds !== undefined) {
    if (!Array.isArray(input.feeds)) errors.push("feeds must be an array");
    else input.feeds.forEach((feed, i) => validateFeed(feed, i, errors));
  }
  if (input.automations !== undefined) {
    if (!Array.isArray(input.automations))
      errors.push("automations must be an array");
    else input.automations.forEach((a, i) => validateAutomation(a, i, errors));
  }
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills)) errors.push("skills must be an array");
    else {
      input.skills.forEach((path, i) => {
        const problem = skillPathError(path);
        if (problem) errors.push(`skills[${i}] ${problem}`);
      });
    }
  }

  const artifacts =
    Object.keys((input.mcpServers as object) || {}).length +
    ((input.feeds as unknown[]) || []).length +
    ((input.automations as unknown[]) || []).length +
    ((input.skills as unknown[]) || []).length;
  if (!artifacts) errors.push("a package must contain at least one artifact");

  if (errors.length) return { errors };
  return { manifest: input as unknown as PackageManifest };
}

/** Parse and validate a manifest's text, so a syntax error reads like one. */
export function parseManifest(text: string): ManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      errors: [
        `${PACKAGE_MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`,
      ],
    };
  }
  return validateManifest(parsed);
}

// ── The ledger ──────────────────────────────────────────────────────────────

export type ArtifactKind = "mcp" | "feed" | "automation" | "skill";

export interface InstalledArtifact {
  kind: ArtifactKind;
  /** The name its own store knows it by: server name, feed id, seed key, skill dir. */
  ref: string;
  /** Skills only: sha256 of SKILL.md, so an upstream edit surfaces as a diff. */
  hash?: string;
}

export interface InstalledPackage {
  name: string;
  version: string;
  description: string;
  /** What was cloned: an owner/repo, a git URL, or a local path. */
  source: string;
  /** The commit installed from, when the source was a git checkout. */
  commit?: string;
  /** Where the checkout lives, so update knows what to fetch into. */
  dir: string;
  installedAt: string;
  updatedAt?: string;
  /** Applied to every MCP server this package installed. */
  allowedUsers?: string[];
  artifacts: InstalledArtifact[];
}

/** The ledger file. `root` overrides the state dir, for tests. */
export function packagesStorePath(root?: string): string {
  return root
    ? `${root}/.opensession-plugins.json`
    : statePath(".opensession-plugins.json");
}

/** Where package checkouts live. `root` overrides the state dir, for tests. */
export function packagesCheckoutDir(root?: string): string {
  return root
    ? `${root}/.opensession-plugins`
    : statePath(".opensession-plugins");
}

export function listInstalledPackages(root?: string): InstalledPackage[] {
  try {
    const raw = JSON.parse(readFileSync(packagesStorePath(root), "utf8"));
    return Array.isArray(raw?.packages) ? raw.packages : [];
  } catch {
    return [];
  }
}

export function readInstalledPackage(
  name: string,
  root?: string,
): InstalledPackage | undefined {
  return listInstalledPackages(root).find((p) => p.name === name);
}

function writeLedger(packages: InstalledPackage[], root?: string): void {
  const path = packagesStorePath(root);
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ packages }, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Record an install or an update. Replaces any entry with the same name. */
export function recordInstalledPackage(
  pkg: InstalledPackage,
  root?: string,
): void {
  const packages = listInstalledPackages(root).filter(
    (p) => p.name !== pkg.name,
  );
  packages.push(pkg);
  packages.sort((a, b) => a.name.localeCompare(b.name));
  writeLedger(packages, root);
}

/** Drop a package from the ledger. Returns false when it was not there. */
export function forgetInstalledPackage(name: string, root?: string): boolean {
  const packages = listInstalledPackages(root);
  const next = packages.filter((p) => p.name !== name);
  if (next.length === packages.length) return false;
  writeLedger(next, root);
  return true;
}
