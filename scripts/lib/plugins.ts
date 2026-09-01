/**
 * Installing a package: fetch, plan, apply, remove.
 *
 * A package is a git repository with `opensession-plugin.json` at its root
 * (src/server/plugins.ts holds the manifest, its validator and the ledger).
 * Installing one means writing its pieces into the stores that already exist
 * for them: MCP servers into mcp-config.json, feeds into the feeds store,
 * automations into the config seed list, skills into `.agents/skills/`.
 *
 * Nothing here evaluates anything it downloaded. `git clone` is the only
 * thing that runs, and it runs with the transports and hooks that could turn
 * a URL into command execution switched off. See adrs/publishable-packages.md.
 *
 * Three shapes worth knowing before editing this file:
 *
 * - **The store port.** Every write goes through `InstanceStores` rather than
 *   straight into a module. That is what lets the tests exercise install and
 *   remove against fakes: importing the real feeds or config writers pins
 *   their paths, and a test that pins the live state dir writes to the live
 *   instance.
 * - **Plan before apply.** `planInstall` is pure and instance-aware: it turns
 *   a manifest plus what is already here into actions, conflicts and (on an
 *   update) removals. Conflicts fail the whole install rather than merging
 *   into somebody else's server, because a half-installed package is worse
 *   than a failed one.
 * - **The ledger is the truth for removal.** Remove walks the recorded
 *   artifact names, never a name prefix, so it can never delete a
 *   hand-written automation that happens to be called the same thing.
 */

import { createHash } from "crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "fs";
import { join } from "path";
import {
  PACKAGE_MANIFEST_FILE,
  PACKAGE_TOPIC,
  forgetInstalledPackage,
  listInstalledPackages,
  packagesCheckoutDir,
  parseManifest,
  readInstalledPackage,
  recordInstalledPackage,
  skillName,
  type ArtifactKind,
  type InstalledArtifact,
  type InstalledPackage,
  type PackageManifest,
} from "../../packages/core/opensession-server/src/server/plugins";
import { REPO_ROOT } from "./paths";
import {
  installRecipe,
  removeRecipe,
  installedKeys,
  type Recipe,
} from "./recipes";
import {
  askYesNo,
  canPrompt,
  dim,
  fail,
  green,
  heading,
  info,
  ok,
  run,
  warn,
} from "./ui";

/**
 * Where an installed skill lands. The engine reads skills from the run's
 * working directory, so an instance-wide install goes in this checkout. The
 * override exists for installs whose checkout is not the working directory,
 * and so a demo or a scratch install never writes into the live one.
 */
export const SKILLS_DIR =
  process.env.OPENSESSION_SKILLS_DIR || join(REPO_ROOT, ".agents", "skills");

// ── Sources ─────────────────────────────────────────────────────────────────

/**
 * Turn what someone typed into something safe to hand `git clone`.
 *
 * `ext::` is remote command execution wearing a URL costume, and a leading
 * dash is an argument pretending to be a source, so both are refused here
 * rather than relying on the clone flags alone.
 */
export function resolveSource(
  input: string,
): { url: string } | { error: string } {
  const source = (input || "").trim();
  if (!source)
    return {
      error: "give a package to install (owner/repo, a git URL, or a path)",
    };
  if (source.startsWith("-"))
    return { error: "a source cannot start with a dash" };
  if (/ext::/i.test(source))
    return { error: "the ext:: transport is not allowed" };

  if (/^[\w.-]+\/[\w.-]+$/.test(source) && !source.startsWith(".")) {
    return { url: `https://github.com/${source}.git` };
  }
  if (/^https?:\/\//i.test(source)) return { url: source };
  if (/^(git@|ssh:\/\/|git:\/\/)/i.test(source)) return { url: source };
  if (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("file://")
  ) {
    return { url: source };
  }
  return {
    error: `unrecognised source '${source}'. Use owner/repo, a git URL, or a path`,
  };
}

/**
 * Do two recorded sources point at the same upstream? `.git` and a trailing
 * slash are noise, and `owner/repo` is the same thing as its https form, so
 * both go through resolveSource first.
 *
 * Case is only folded for remote URLs. A local path is a filesystem path, and
 * on a case-sensitive filesystem /tmp/Pkg and /tmp/pkg are two repositories.
 */
export function sameOrigin(a: string, b: string): boolean {
  const normalise = (input: string): string => {
    const resolved = resolveSource(input);
    const url = ("url" in resolved ? resolved.url : input).trim();
    const trimmed = url.replace(/\.git$/i, "").replace(/\/+$/, "");
    const local = /^([/.]|file:\/\/)/.test(trimmed);
    return local ? trimmed : trimmed.toLowerCase();
  };
  return !!a && !!b && normalise(a) === normalise(b);
}

/**
 * The ledger entry this install belongs to.
 *
 * By name first, which is the ordinary case, then by where it came from. A
 * package is free to rename itself upstream, and looking it up only by the new
 * name found nothing: the install then read as a first install, so the
 * artifacts it already owns came back as conflicts against itself — or, when
 * the rename renamed them too, it wrote a second ledger entry and left the
 * first one with nothing pointing at it and no way to remove it by name.
 */
export function findInstalledPackage(
  name: string,
  source: string,
): InstalledPackage | undefined {
  return (
    readInstalledPackage(name) ??
    listInstalledPackages().find((pkg) => sameOrigin(pkg.source, source))
  );
}

const CLONE_HARDENING = [
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "core.hooksPath=/dev/null",
];

/**
 * Clone (or, when the checkout is already there, fetch) into `dir`, and
 * report the commit that landed.
 */
export async function fetchPackage(
  url: string,
  dir: string,
): Promise<{ commit: string } | { error: string }> {
  if (existsSync(join(dir, ".git"))) {
    const fetched = await run([
      "git",
      ...CLONE_HARDENING,
      "-C",
      dir,
      "fetch",
      "--depth",
      "1",
      "origin",
      "HEAD",
    ]);
    if (fetched.code !== 0)
      return { error: fetched.stderr || "git fetch failed" };
    const checkout = await run([
      "git",
      "-C",
      dir,
      "checkout",
      "--detach",
      "FETCH_HEAD",
    ]);
    if (checkout.code !== 0)
      return { error: checkout.stderr || "git checkout failed" };
  } else {
    const cloned = await run([
      "git",
      ...CLONE_HARDENING,
      "clone",
      "--depth",
      "1",
      "--no-recurse-submodules",
      "--quiet",
      url,
      dir,
    ]);
    if (cloned.code !== 0)
      return { error: cloned.stderr || "git clone failed" };
  }
  const head = await run(["git", "-C", dir, "rev-parse", "HEAD"]);
  return { commit: head.code === 0 ? head.stdout.trim() : "" };
}

/**
 * Read and validate the manifest in a fetched checkout, including the parts
 * that need the filesystem: a declared skill directory has to exist and hold
 * a SKILL.md.
 */
export function readPackage(
  dir: string,
): { manifest: PackageManifest } | { errors: string[] } {
  const path = join(dir, PACKAGE_MANIFEST_FILE);
  if (!existsSync(path)) {
    return { errors: [`no ${PACKAGE_MANIFEST_FILE} at the repository root`] };
  }
  const parsed = parseManifest(readFileSync(path, "utf8"));
  if ("errors" in parsed) return parsed;

  const errors: string[] = [];
  for (const skill of parsed.manifest.skills || []) {
    if (!existsSync(join(dir, skill, "SKILL.md"))) {
      errors.push(`skills: ${skill}/SKILL.md is missing from the package`);
    }
  }
  return errors.length ? { errors } : parsed;
}

// ── Planning ────────────────────────────────────────────────────────────────

export interface PlanAction {
  kind: ArtifactKind;
  /** The name the artifact's own store knows it by. */
  ref: string;
  /** Adding something new, or replacing this package's own earlier copy. */
  verb: "add" | "update";
  /** One line for the review summary. */
  detail: string;
  /** The manifest piece to install, carried so apply needs no second lookup. */
  payload?: unknown;
  /** Skills only: the incoming SKILL.md's hash, and the one already installed.
   *  A SKILL.md is text an agent loads into context, so an upstream rewrite is
   *  a code change, and the review has to show it rather than swap it in. */
  hash?: string;
  previousHash?: string;
}

export interface InstallPlan {
  actions: PlanAction[];
  /** Names already taken by something this package does not own. */
  conflicts: string[];
  /** On an update: artifacts the new manifest no longer declares. */
  removals: InstalledArtifact[];
  /** Things worth reading before confirming, but not reasons to refuse. */
  warnings: string[];
}

/** What the instance already has, as plain names. */
export interface InstanceState {
  mcpServers: string[];
  feeds: string[];
  automations: Set<string>;
  skills: string[];
}

/** The seed key `ensureConfiguredAutomations` matches on. */
export function automationKey(automation: {
  eventKey?: string;
  name: string;
}): string {
  return automation.eventKey || automation.name;
}

/** A package automation, shaped as the recipe installer already understands. */
export function recipeFor(
  pkg: string,
  entry: {
    id: string;
    label?: string;
    description?: string;
    requires?: string[];
    automation: any;
  },
): Recipe {
  return {
    id: `${pkg}/${entry.id}`,
    label: entry.label || entry.automation.name,
    description: entry.description || "",
    ...(entry.requires?.length ? { requires: entry.requires } : {}),
    // A package proposes a job; the operator starts it.
    automation: { ...entry.automation, enabled: false },
  };
}

function owns(
  owned: InstalledArtifact[],
  kind: ArtifactKind,
  ref: string,
): boolean {
  return owned.some((a) => a.kind === kind && a.ref === ref);
}

/**
 * Turn a manifest plus the current instance into actions. Pure, so the CLI
 * can print exactly what it is about to do and the tests can assert it
 * without touching a store.
 */
export function planInstall(
  manifest: PackageManifest,
  state: InstanceState,
  owned: InstalledArtifact[] = [],
  /** Hash of a skill directory's SKILL.md in the fetched checkout. Injected so
   *  planning stays free of IO; without it a skill's line says only where it
   *  lands, which is all a first install can say anyway. */
  hashSkill?: (relPath: string) => string | undefined,
): InstallPlan {
  const actions: PlanAction[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const declaredServers = Object.keys(manifest.mcpServers || {});

  const consider = (
    kind: ArtifactKind,
    ref: string,
    present: boolean,
    detail: string,
    payload?: unknown,
    hashes?: { hash?: string; previousHash?: string },
  ) => {
    const mine = owns(owned, kind, ref);
    if (present && !mine) {
      conflicts.push(
        `${kind} "${ref}" already exists and is not from this package`,
      );
      return;
    }
    actions.push({
      kind,
      ref,
      verb: mine ? "update" : "add",
      detail,
      payload,
      ...hashes,
    });
  };

  for (const [name, cfg] of Object.entries(manifest.mcpServers || {})) {
    const target = cfg.url || [cfg.command, ...(cfg.args || [])].join(" ");
    const secrets = [
      ...Object.keys(cfg.env || {}),
      ...Object.values(cfg.headers || {}).map((v) => v.replace(/[${}]/g, "")),
    ];
    consider(
      "mcp",
      name,
      state.mcpServers.includes(name),
      `${cfg.url ? "http" : "stdio"} ${target}${secrets.length ? ` (needs ${secrets.join(", ")})` : ""}`,
      cfg,
    );
  }

  for (const feed of manifest.feeds || []) {
    consider(
      "feed",
      feed.id,
      state.feeds.includes(feed.id),
      `${feed.title} via ${feed.items.server}`,
      feed,
    );
    const server = feed.items.server;
    if (
      !declaredServers.includes(server) &&
      !state.mcpServers.includes(server)
    ) {
      warnings.push(
        `feed "${feed.id}" reads from MCP server "${server}", which is not installed`,
      );
    }
  }

  for (const entry of manifest.automations || []) {
    const key = automationKey(entry.automation);
    consider(
      "automation",
      key,
      state.automations.has(key),
      `${entry.automation.schedule ? `${entry.automation.schedule} ` : ""}${entry.label || entry.automation.name} (installs disabled)`,
      entry,
    );
  }

  for (const path of manifest.skills || []) {
    const name = skillName(path);
    const hash = hashSkill?.(path);
    const previousHash = owned.find(
      (a) => a.kind === "skill" && a.ref === name,
    )?.hash;
    const change =
      !previousHash || !hash
        ? ""
        : hash === previousHash
          ? " (unchanged)"
          : ` (content changed: ${previousHash.slice(0, 8)} to ${hash.slice(0, 8)})`;
    consider(
      "skill",
      name,
      state.skills.includes(name),
      `${SKILLS_DIR}/${name}/${change}`,
      path,
      { hash, previousHash },
    );
  }

  const keep = new Set(actions.map((a) => `${a.kind}:${a.ref}`));
  const removals = owned.filter((a) => !keep.has(`${a.kind}:${a.ref}`));

  return { actions, conflicts, removals, warnings };
}

// ── The store port ──────────────────────────────────────────────────────────

export interface InstanceStores {
  state(): Promise<InstanceState>;
  addMcpServer(name: string, entry: unknown, allowedUsers?: string[]): void;
  removeMcpServer(name: string): void;
  upsertFeed(feed: unknown): void;
  removeFeed(id: string): void;
  addAutomation(recipe: Recipe, createdBy: string): Promise<void>;
  removeAutomation(recipe: Recipe): Promise<void>;
  /** Copies the skill directory in; returns the sha256 of its SKILL.md. */
  addSkill(name: string, sourceDir: string): string;
  removeSkill(name: string): void;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The real stores. Imported lazily so this module stays cheap to load. */
export async function defaultStores(): Promise<InstanceStores> {
  const connections =
    await import("../../packages/core/opensession-server/src/server/connections");
  const feeds =
    await import("../../packages/core/opensession-server/src/server/feeds-config");
  const { readdirSync } = await import("fs");

  const skillNames = () => {
    try {
      return readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  };

  return {
    async state() {
      return {
        mcpServers: Object.keys(connections.readMcpConfig().mcpServers || {}),
        feeds: feeds.readConfigFeeds().map((f) => f.id),
        automations: await installedKeys(),
        skills: skillNames(),
      };
    },
    addMcpServer(name, entry, allowedUsers) {
      // Replacing this package's own earlier copy is an update, so drop
      // the old entry first rather than failing the no-overwrite guard.
      connections.removeMcpServer(name);
      const result = connections.addMcpServerEntry(
        name,
        entry as Record<string, unknown>,
        {
          allowedUsers,
        },
      );
      if ("error" in result) throw new Error(result.error);
    },
    removeMcpServer(name) {
      connections.removeMcpServer(name);
    },
    upsertFeed(feed) {
      const result = feeds.upsertConfigFeed(feed);
      if ("error" in result) throw new Error(result.error);
    },
    removeFeed(id) {
      feeds.removeConfigFeed(id);
    },
    async addAutomation(recipe, createdBy) {
      await installRecipe(recipe, createdBy);
    },
    async removeAutomation(recipe) {
      await removeRecipe(recipe);
    },
    addSkill(name, sourceDir) {
      const dest = join(SKILLS_DIR, name);
      rmSync(dest, { recursive: true, force: true });
      cpSync(sourceDir, dest, { recursive: true });
      return sha256(join(dest, "SKILL.md"));
    },
    removeSkill(name) {
      // Only ever a directory this installer created, named in the ledger.
      rmSync(join(SKILLS_DIR, name), { recursive: true, force: true });
    },
  };
}

// ── Applying ────────────────────────────────────────────────────────────────

export interface ApplyInput {
  manifest: PackageManifest;
  plan: InstallPlan;
  stores: InstanceStores;
  /** The fetched checkout, for copying skills out of. */
  dir: string;
  source: string;
  commit?: string;
  allowedUsers?: string[];
  /** Carried through so an update keeps the original install date. */
  installedAt?: string;
}

/**
 * Apply a plan, returning the ledger entry to record. Rolls back anything it
 * added in this run if a later step throws: a package that half-installed is
 * a package nobody can cleanly remove.
 */
export async function applyPlan(input: ApplyInput): Promise<InstalledPackage> {
  const { manifest, plan, stores, dir } = input;
  const added: InstalledArtifact[] = [];
  const artifacts: InstalledArtifact[] = [];

  const order: ArtifactKind[] = ["mcp", "feed", "automation", "skill"];
  const sorted = [...plan.actions].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );

  try {
    for (const action of sorted) {
      let artifact: InstalledArtifact = { kind: action.kind, ref: action.ref };
      if (action.kind === "mcp") {
        stores.addMcpServer(action.ref, action.payload, input.allowedUsers);
      } else if (action.kind === "feed") {
        stores.upsertFeed(action.payload);
      } else if (action.kind === "automation") {
        await stores.addAutomation(
          recipeFor(manifest.name, action.payload as any),
          `opensession package: ${manifest.name}`,
        );
      } else {
        const hash = stores.addSkill(
          action.ref,
          join(dir, String(action.payload)),
        );
        artifact = { ...artifact, hash };
      }
      artifacts.push(artifact);
      if (action.verb === "add") added.push(artifact);
    }

    // An update drops what the new manifest no longer declares.
    for (const stale of plan.removals) {
      await removeArtifact(stale, manifest, stores);
    }
  } catch (e) {
    for (const artifact of added.reverse()) {
      try {
        await removeArtifact(artifact, manifest, stores);
      } catch {
        // Rolling back is best-effort; the original failure is the story.
      }
    }
    throw e;
  }

  const now = new Date().toISOString();
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    source: input.source,
    ...(input.commit ? { commit: input.commit } : {}),
    dir,
    installedAt: input.installedAt || now,
    ...(input.installedAt ? { updatedAt: now } : {}),
    ...(input.allowedUsers?.length ? { allowedUsers: input.allowedUsers } : {}),
    artifacts,
  };
}

async function removeArtifact(
  artifact: InstalledArtifact,
  manifest: PackageManifest | { name: string; automations?: unknown[] },
  stores: InstanceStores,
): Promise<void> {
  switch (artifact.kind) {
    case "mcp":
      stores.removeMcpServer(artifact.ref);
      return;
    case "feed":
      stores.removeFeed(artifact.ref);
      return;
    case "skill":
      stores.removeSkill(artifact.ref);
      return;
    case "automation": {
      // removeRecipe matches on the seed key, which is all the ledger has,
      // so a stub recipe carrying that key is enough to reverse the seed.
      await stores.removeAutomation({
        id: `${manifest.name}/${artifact.ref}`,
        label: artifact.ref,
        description: "",
        automation: { name: artifact.ref, prompt: "", eventKey: artifact.ref },
      });
    }
  }
}

/**
 * Reverse every artifact a package installed. Idempotent: an artifact a human
 * already deleted is not an error, because the point of remove is to leave
 * nothing behind rather than to assert what was there.
 */
export async function removeInstalled(
  pkg: InstalledPackage,
  stores: InstanceStores,
): Promise<void> {
  for (const artifact of [...pkg.artifacts].reverse()) {
    try {
      await removeArtifact(artifact, pkg, stores);
    } catch {
      // Keep going: one missing artifact must not strand the rest.
    }
  }
  if (pkg.dir && pkg.dir.includes(".opensession-plugins")) {
    rmSync(pkg.dir, { recursive: true, force: true });
  }
}

/** The review a human reads before confirming an install. */
export function reviewLines(
  manifest: PackageManifest,
  plan: InstallPlan,
): string[] {
  const lines: string[] = [];
  const label: Record<ArtifactKind, string> = {
    mcp: "MCP server",
    feed: "feed",
    automation: "automation",
    skill: "skill",
  };
  for (const action of plan.actions) {
    lines.push(
      `${label[action.kind].padEnd(11)} ${action.ref.padEnd(22)} ${action.detail}`,
    );
  }
  for (const stale of plan.removals) {
    lines.push(
      `${label[stale.kind].padEnd(11)} ${stale.ref.padEnd(22)} removed (no longer in the manifest)`,
    );
  }
  return lines;
}

// ── The `opensession plugins` command ───────────────────────────────────────

export interface PluginsOptions {
  /** Skip the confirmation. The line a scripted caller crosses deliberately. */
  yes?: boolean;
  /** Applied to every MCP server the package installs. */
  users?: string;
}

function parseUsers(users?: string): string[] | undefined {
  const list = (users || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

async function listPackages(): Promise<number> {
  const packages = listInstalledPackages();
  if (!packages.length) {
    heading("Packages");
    info(dim("none installed"));
    info(dim(`\n  opensession plugins add <owner/repo>`));
    info(dim(`  github.com/topics/${PACKAGE_TOPIC}`));
    return 0;
  }
  heading("Packages");
  for (const pkg of packages) {
    info(
      `${green(pkg.name.padEnd(20))} ${pkg.version.padEnd(10)} ${dim(pkg.description)}`,
    );
    info(
      `  ${dim(pkg.source)}${pkg.commit ? dim(` @ ${pkg.commit.slice(0, 8)}`) : ""}`,
    );
    const by: Record<string, string[]> = {};
    for (const a of pkg.artifacts) (by[a.kind] ||= []).push(a.ref);
    for (const [kind, refs] of Object.entries(by)) {
      info(`  ${dim(`${kind}: ${refs.join(", ")}`)}`);
    }
    if (pkg.allowedUsers?.length) {
      info(`  ${dim(`scoped to: ${pkg.allowedUsers.join(", ")}`)}`);
    }
  }
  return 0;
}

/**
 * The review gate. Everything the install would write, printed before it
 * writes any of it, because reading this IS the trust model.
 */
function confirmPlan(
  manifest: PackageManifest,
  plan: InstallPlan,
  source: string,
  commit: string | undefined,
  allowedUsers: string[] | undefined,
  yes: boolean,
  renamedFrom?: string,
): boolean {
  heading(`${manifest.name} ${manifest.version}`);
  info(dim(manifest.description));
  info(dim(`${source}${commit ? ` @ ${commit.slice(0, 8)}` : ""}`));
  // Named before the artifact lines, because it changes what the operator is
  // looking at: this is the package they know under the old name.
  if (renamedFrom) info(`renamed: ${renamedFrom} → ${manifest.name}`);
  console.log("");
  for (const line of reviewLines(manifest, plan)) info(line);
  if (allowedUsers?.length) {
    info(dim(`\n  servers scoped to: ${allowedUsers.join(", ")}`));
  } else if (plan.actions.some((a) => a.kind === "mcp")) {
    info(
      dim(
        `\n  servers are available to every session (use --users to scope them)`,
      ),
    );
  }
  for (const warning of plan.warnings) warn(warning);
  // An upstream rewrite of a SKILL.md is a change to what the model is told,
  // so it gets named rather than folded into the generic caution.
  const rewritten = plan.actions
    .filter(
      (a) =>
        a.kind === "skill" &&
        a.previousHash &&
        a.hash &&
        a.hash !== a.previousHash,
    )
    .map((a) => a.ref);
  if (rewritten.length) {
    warn(
      `upstream rewrote ${rewritten.join(", ")}`,
      `read the new text: ${SKILLS_DIR}/${rewritten[0]}/SKILL.md is replaced`,
    );
  } else if (plan.actions.some((a) => a.kind === "skill")) {
    warn(
      "a skill is text an agent loads into context",
      "read it before confirming",
    );
  }
  console.log("");
  if (yes) return true;
  if (!canPrompt()) {
    fail(
      "not a terminal",
      "re-run with --yes once you have read the plan above",
    );
    return false;
  }
  return askYesNo("Install this package?", false);
}

async function addPackage(
  source: string,
  opts: PluginsOptions,
): Promise<number> {
  const resolved = resolveSource(source);
  if ("error" in resolved) {
    fail(resolved.error);
    return 1;
  }

  const root = packagesCheckoutDir();
  mkdirSync(root, { recursive: true });
  const staging = join(root, `.staging-${Date.now().toString(36)}`);
  rmSync(staging, { recursive: true, force: true });

  const fetched = await fetchPackage(resolved.url, staging);
  if ("error" in fetched) {
    rmSync(staging, { recursive: true, force: true });
    fail("could not fetch the package", fetched.error.split("\n")[0]);
    return 1;
  }

  const read = readPackage(staging);
  if ("errors" in read) {
    rmSync(staging, { recursive: true, force: true });
    fail(`${PACKAGE_MANIFEST_FILE} is not valid`);
    for (const problem of read.errors) info(dim(`  ${problem}`));
    return 1;
  }
  const { manifest } = read;

  const existing = findInstalledPackage(manifest.name, source);
  // Same install, new name upstream. The plan below then treats the artifacts
  // as this package's own — an update, not a collision — and the ledger entry
  // moves to the new name instead of a second one appearing beside it.
  const renamedFrom =
    existing && existing.name !== manifest.name ? existing.name : undefined;
  const dir = join(root, manifest.name);
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);

  const stores = await defaultStores();
  const plan = planInstall(
    manifest,
    await stores.state(),
    existing?.artifacts || [],
    (rel) => {
      const path = join(dir, rel, "SKILL.md");
      return existsSync(path) ? sha256(path) : undefined;
    },
  );
  if (plan.conflicts.length) {
    fail(`${manifest.name} would collide with what is already here`);
    for (const conflict of plan.conflicts) info(dim(`  ${conflict}`));
    if (!existing) rmSync(dir, { recursive: true, force: true });
    return 1;
  }

  const allowedUsers = parseUsers(opts.users) || existing?.allowedUsers;
  if (
    !confirmPlan(
      manifest,
      plan,
      source,
      fetched.commit,
      allowedUsers,
      !!opts.yes,
      renamedFrom,
    )
  ) {
    if (!existing) rmSync(dir, { recursive: true, force: true });
    info(dim("nothing was installed"));
    return 1;
  }

  try {
    const record = await applyPlan({
      manifest,
      plan,
      stores,
      dir,
      source,
      commit: fetched.commit,
      allowedUsers,
      installedAt: existing?.installedAt,
    });
    recordInstalledPackage(record);
    if (renamedFrom) {
      // New entry first, then drop the old name: interrupted here the
      // package is listed twice, which a re-run settles. The other order
      // would leave it listed nowhere and unremovable.
      forgetInstalledPackage(renamedFrom);
      if (
        existing?.dir &&
        existing.dir !== dir &&
        existing.dir.includes(".opensession-plugins")
      ) {
        rmSync(existing.dir, { recursive: true, force: true });
      }
    }
    ok(
      `${existing ? "updated" : "installed"} ${manifest.name} ${manifest.version}`,
      renamedFrom ? `renamed from ${renamedFrom}` : undefined,
    );
  } catch (e) {
    fail("install failed and was rolled back", (e as Error).message);
    return 1;
  }

  if (manifest.requires?.length) {
    info(
      dim(
        `  needs: ${manifest.requires.join(", ")} (opensession integrations enable <id>)`,
      ),
    );
  }
  if (plan.actions.some((a) => a.kind === "automation")) {
    warn(
      "automations were seeded disabled",
      "restart to create them, then enable in the UI",
    );
  }
  return 0;
}

async function updatePackage(
  name: string,
  opts: PluginsOptions,
): Promise<number> {
  const existing = readInstalledPackage(name);
  if (!existing) {
    fail(`'${name}' is not installed`, "opensession plugins");
    return 1;
  }
  return await addPackage(existing.source, { ...opts, users: opts.users });
}

async function removePackage(name: string): Promise<number> {
  const existing = readInstalledPackage(name);
  if (!existing) {
    fail(`'${name}' is not installed`, "opensession plugins");
    return 1;
  }
  await removeInstalled(existing, await defaultStores());
  forgetInstalledPackage(name);
  ok(`removed ${name}`, `${existing.artifacts.length} artifacts reversed`);
  if (existing.artifacts.some((a) => a.kind === "automation")) {
    info(
      dim(
        "  an automation already created from it is untouched. Delete it in the UI",
      ),
    );
  }
  return 0;
}

/**
 * `opensession plugins [add|update|remove]`. Installing is a CLI verb rather
 * than a button on purpose: the review it prints is the gate, and a one-click
 * install of a third party's MCP server is exactly the thing this format is
 * careful not to offer.
 */
export async function plugins(
  positional: string[],
  opts: PluginsOptions = {},
): Promise<number> {
  const [verb, arg] = positional;
  if (verb === "add" || verb === "install")
    return await addPackage(arg ?? "", opts);
  if (verb === "update") return await updatePackage(arg ?? "", opts);
  if (verb === "remove" || verb === "uninstall")
    return await removePackage(arg ?? "");
  if (!verb || verb === "list") return await listPackages();
  fail(
    `unknown subcommand '${verb}'`,
    "usage: opensession plugins [add|update|remove]",
  );
  return 1;
}
