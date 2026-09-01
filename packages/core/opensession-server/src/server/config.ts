/**
 * Open Session instance configuration.
 *
 * Single `~/.opensession/config.json` (dual-read fallback to `~/.backstage/
 * config.json`; path overridable via OPENSESSION_CONFIG, or the deprecated
 * OPENSESSION_CONFIG),
 * read fresh per call with the sandbox/config.ts pattern: tolerant parse,
 * missing/invalid file → portable built-in defaults.
 *
 * Precedence per key: existing env var → config.json → built-in default.
 *
 * The top-level `onboardingCompleted` gate and sections `server`, `paths`,
 * `storage`, `repos`, `identity`, `organization`, `persona`, `branding`,
 * `policy`, and integration-specific settings are consumed by their owning
 * modules. See config.example.json at the repo root for the full schema.
 */

import { homeDir } from "./paths";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve as resolvePath } from "path";
import { statePath } from "./paths";
import { writeFileAtomic } from "./shared/atomic-write";
import { shellSafeDefaultBranch } from "./repo-branch";

const HOME = homeDir();
const OPENSESSION_ROOT = resolvePath(import.meta.dir, "../../../../..");

export function configPath(): string {
  return (
    process.env.OPENSESSION_CONFIG || statePath(".opensession/config.json")
  );
}

// ---------------------------------------------------------------------------
// Config file shape (everything optional — absent keys fall to defaults)
// ---------------------------------------------------------------------------

export interface ServerSection {
  host?: string;
  port?: number;
  /** Public web-UI base, e.g. "https://opensession.example.com". */
  publicBaseUrl?: string;
  /** Host previews are served from (Caddy-fronted). */
  previewHost?: string;
  /** Caddy admin API endpoint. */
  caddyAdmin?: string;
}

export interface PathsSection {
  claudeBin?: string;
  worktreesDir?: string;
  mcpConfig?: string;
}

/** Optional S3-compatible storage for session assets. Local disk stays the
 * default when this section is absent. */
export interface AssetStorageSection {
  provider?: "local" | "s3";
  bucket?: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export interface StorageSection {
  assets?: AssetStorageSection;
}

export type IngressExposure = "cloudflare" | "custom";

/** The separately exposed public origin. The private app origin remains an
 * independent server setting and is never implied by this section. */
export interface IngressSection {
  publicBaseUrl?: string;
  exposure?: IngressExposure;
  /** Cloudflare named-tunnel id, used only to render its required CNAME. */
  cloudflareTunnelId?: string;
}

/** How NEW sessions on a `sharedCheckout` repo get their working dir — see
 *  configuredSelfDev(). */
export type SelfDevMode = "shared" | "worktree";

/** A `repos` entry in config.json — partial; merged over the built-in repo
 *  with the same id, or (with at least `repo`) adds a new one. */
export interface RepoSection {
  /** Human-readable label; defaults to the repo id. */
  label?: string;
  /** Short routing hint shown to the Slack intent classifier. */
  description?: string;
  repo?: string;
  wtPrefix?: string;
  defaultBranch?: string;
  ghRepo?: string;
  /** Git host backing this repo. Absent/"github" = GitHub (the default,
   *  unchanged behavior); "codestorage" = code.storage (needs `csRepo` and
   *  `integrations.codeStorage`). */
  host?: "github" | "codestorage";
  /** code.storage repo id/path (the JWT `repo` claim), e.g. "acme/widget". */
  csRepo?: string;
  sharedCheckout?: boolean;
  /** Marks this repo as the instance default (see defaultRepo()). */
  default?: boolean;
  /** PNG served as the repo's tile icon (absolute path, or relative to the
   *  checkout); unset = the colored letter tile. Settings → Setup can fetch
   *  the owner's GitHub avatar into one of these. */
  icon?: string;
  /** Where that icon came from, when we fetched or stored it — so the tile
   *  picker can show which of its choices is the one in use. Absent for an
   *  `icon` written by hand into the config. */
  iconSource?: "github" | "upload";
  /** Overrides the tile color the server would otherwise assign, as
   *  "#rrggbb". Set from Settings → Setup; see repo-tile-colors.ts. */
  color?: string;
  previewCommand?: string;
  /** One-time setup command run in a fresh worktree before depsInstall. */
  worktreeSetup?: string;
  depsInstall?: string;
  /** Include this repo in the bulk PR cache (true by default when ghRepo exists). */
  prCache?: boolean;
  prCacheOpenLimit?: number;
  prCacheRecentLimit?: number;
  /** Repo-relative files worth retaining in warm preview snapshots. */
  warmCachePaths?: string[];
  /** Optional AWS profile name a preview expects in addition to `default`. */
  previewAwsProfile?: string;
  /** Track the deployment workflow after a PR is merged. */
  deploymentTracking?: boolean;
  /** Repo-specific threat-model/build notes appended to security scan prompts. */
  securityInstructions?: string;
}

export interface TeamMember {
  /** Full display name (also the git author name). */
  name: string;
  /** Git author/committer email for commit attribution. */
  email?: string;
  /** Picker names / short aliases (lowercase), e.g. ["alice"]. */
  aliases?: string[];
  slackId?: string;
  /** GitHub login. */
  github?: string;
  /** Emails their Linear account uses (may differ from the git email). */
  linearEmails?: string[];
  /** IANA timezone, e.g. "Europe/Amsterdam" — used wherever we compute
   * local times for a person (todo reminders). */
  timezone?: string;
  /** May change workspace-owned settings. When at least one team member sets
   * this flag, only flagged members are workspace administrators. Omission on
   * every member preserves the historical all-members-are-admin behavior. */
  admin?: boolean;
  /**
   * Include in the GitHub→Slack notification map (GITHUB_TO_SLACK). Default
   * true when both `github` and `slackId` are set; set false to keep someone
   * out of GitHub-event Slack pings without dropping their other mappings.
   */
  githubToSlack?: boolean;
  /**
   * Include in the team directory (GET /api/people: People band, pickers,
   * @-mention completion + pushes). Default true; set false for identities
   * kept only for commit/Slack/Linear attribution (e.g. contractors).
   */
  directory?: boolean;
}

export interface ReviewTeam {
  /** Human label shown in reviewer pickers. */
  name: string;
  /** GitHub reviewer spec, e.g. "acme/platform-reviewers". */
  github: string;
  /** Team-member names/aliases whose Open Session sidebars receive the request. */
  members: string[];
}

export interface IdentitySection {
  team?: TeamMember[];
  reviewTeams?: ReviewTeam[];
  /** IANA timezone used when a team member has no explicit timezone. */
  defaultTimezone?: string;
  /** Extra Slack id → display name entries (bots, legacy workspace ids) that
   *  aren't full team members. */
  slackNames?: Record<string, string>;
}

/** Integration-owned settings. Each module validates the keys it consumes. */
export interface IntegrationsSection {
  [integration: string]: unknown;
}

/** Optional policy overrides. */
export interface PolicySection {
  stripeConfirmTools?: string[];
  automationDeniedTools?: string[];
  /** GitHub owners the agent may write to without per-conversation approval. */
  githubWriteOwners?: string[];
  /** Bot accounts trusted to attach PRs to sessions via attribution footers. */
  githubBotLogins?: string[];
}

/** Persona copy in prompt builders. */
export interface PersonaSection {
  name?: string;
  company?: string;
  product?: string;
}

/** The company or team sharing this Open Session instance. */
export interface OrganizationSection {
  /** Workspace name shown to everyone using the instance. */
  name?: string;
}

/** Instance branding — what the *platform itself* is called in the UI
 *  (distinct from persona: `persona.name` is the agent, `persona.product`
 *  is the company's product the agent supports). */
export interface BrandingSection {
  /** Product name rendered in titles/headers, e.g. "Open Session". */
  productName?: string;
  /** Short visual monogram for brand-mark contexts (logo chip, favicon);
   *  defaults to productName. */
  productMark?: string;
}

export interface OpenSessionConfig {
  /** The instance-wide first-run walkthrough has been explicitly finished. */
  onboardingCompleted?: boolean;
  server?: ServerSection;
  ingress?: IngressSection;
  paths?: PathsSection;
  storage?: StorageSection;
  /** Working-dir policy for `sharedCheckout` repos' new sessions. */
  selfDev?: SelfDevMode;
  repos?: Record<string, RepoSection>;
  /** Registered repo shown by default in the New-session picker. */
  newSessionRepo?: string;
  identity?: IdentitySection;
  integrations?: IntegrationsSection;
  policy?: PolicySection;
  organization?: OrganizationSection;
  persona?: PersonaSection;
  branding?: BrandingSection;
}

// ---------------------------------------------------------------------------
// Resolved shapes (defaults applied)
// ---------------------------------------------------------------------------

// The *repo* concept sessions run against (moved here from worktree.ts so the
// registry can be config-driven; worktree.ts re-exports the type). Worktrees
// live at <worktreesDir>/<wtPrefix>-<branch>; defaultBranch is the base they
// branch from.
//
// NOTE: a "Project" in the UI is a separate thing — an optional folder that
// groups sessions (see src/server/projects.ts). A session's worktree lives on the
// session and belongs to one of these repos.
export interface Repo {
  id: string;
  label: string;
  description?: string;
  repo: string;
  wtPrefix: string;
  defaultBranch: string;
  /** GitHub `owner/name` for PR operations (gh CLI). */
  ghRepo: string;
  /** Backing git host; undefined means GitHub (see RepoSection.host). */
  host?: "github" | "codestorage";
  /** code.storage repo id/path when host is "codestorage". */
  csRepo?: string;
  // When true, code sessions run directly in the main checkout on the default
  // branch instead of an isolated worktree. Open Session is self-hosting from its
  // main checkout; sessions share one tree and commit straight to the default
  // branch (see "Open Session dev workflow" in AGENTS.md: add → commit → push,
  // never reset/discard the shared repo).
  sharedCheckout?: boolean;
  /** Instance default repo (defaultRepo()). */
  default?: boolean;
  /** Tile-icon PNG path (see RepoSection.icon). */
  icon?: string;
  /** Where that icon came from (see RepoSection.iconSource). */
  iconSource?: "github" | "upload";
  /** Chosen tile color, "#rrggbb" (see RepoSection.color). */
  color?: string;
  /** Dev-server bring-up command for previews. */
  previewCommand?: string;
  worktreeSetup?: string;
  /** Shell command (run with cwd = the fresh worktree) that installs deps.
   *  Unset = `bun install` at the repo root when package.json exists. */
  depsInstall?: string;
  prCache?: boolean;
  prCacheOpenLimit?: number;
  prCacheRecentLimit?: number;
  warmCachePaths?: string[];
  previewAwsProfile?: string;
  deploymentTracking?: boolean;
  securityInstructions?: string;
}

export interface ResolvedServer {
  host: string;
  port: number;
  publicBaseUrl: string;
  webhookBaseUrl: string;
  previewHost: string;
  caddyAdmin: string;
}

export interface ResolvedIngress {
  publicBaseUrl: string;
  exposure: IngressExposure | null;
  cloudflareTunnelId: string;
}

export interface ResolvedPaths {
  claudeBin: string;
  worktreesDir: string;
  mcpConfig: string;
}

export interface ResolvedIdentity {
  team: TeamMember[];
  reviewTeams: ReviewTeam[];
  slackNames: Record<string, string>;
  defaultTimezone: string;
}

// ---------------------------------------------------------------------------
// Portable defaults
// ---------------------------------------------------------------------------

function builtinRepos(): Record<string, Repo> {
  return {
    opensession: {
      id: "opensession",
      label: "Open Session",
      description: "The Open Session server, web UI, agents, and client apps.",
      repo: OPENSESSION_ROOT,
      wtPrefix: "opensession",
      defaultBranch: "main",
      ghRepo: "",
      sharedCheckout: true,
      default: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : undefined;

/** Drop undefined values so spreading a partial never clobbers a default. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function parseRepoSection(v: unknown): RepoSection | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const rawHost = str(o.host);
  // Unknown host values are dropped → the repo stays a plain GitHub repo.
  const host: RepoSection["host"] =
    rawHost === "github" || rawHost === "codestorage" ? rawHost : undefined;
  const rawIconSource = str(o.iconSource);
  const iconSource: RepoSection["iconSource"] =
    rawIconSource === "github" || rawIconSource === "upload"
      ? rawIconSource
      : undefined;
  return defined({
    label: str(o.label),
    description: str(o.description),
    repo: str(o.repo),
    wtPrefix: str(o.wtPrefix),
    defaultBranch: shellSafeDefaultBranch(o.defaultBranch),
    ghRepo: str(o.ghRepo),
    host,
    csRepo: str(o.csRepo),
    sharedCheckout: bool(o.sharedCheckout),
    default: bool(o.default),
    icon: str(o.icon),
    iconSource,
    color: str(o.color),
    previewCommand: str(o.previewCommand),
    worktreeSetup: str(o.worktreeSetup),
    depsInstall: str(o.depsInstall),
    prCache: bool(o.prCache),
    prCacheOpenLimit: num(o.prCacheOpenLimit),
    prCacheRecentLimit: num(o.prCacheRecentLimit),
    warmCachePaths: strArray(o.warmCachePaths),
    previewAwsProfile: str(o.previewAwsProfile),
    deploymentTracking: bool(o.deploymentTracking),
    securityInstructions: str(o.securityInstructions),
  });
}

/** Exported for the setup routes: web team-CRUD validates candidate members
 *  through the exact rules the config loader accepts. */
export function parseTeamMember(v: unknown): TeamMember | undefined {
  const o = obj(v);
  const name = str(o?.name);
  if (!o || !name) return undefined;
  return {
    name,
    ...defined({
      email: str(o.email),
      aliases: strArray(o.aliases),
      slackId: str(o.slackId),
      github: str(o.github),
      linearEmails: strArray(o.linearEmails),
      githubToSlack: bool(o.githubToSlack),
      directory: bool(o.directory),
      timezone: str(o.timezone),
      admin: bool(o.admin),
    }),
  };
}

function parseReviewTeam(v: unknown): ReviewTeam | undefined {
  const o = obj(v);
  const name = str(o?.name);
  const github = str(o?.github);
  const members = strArray(o?.members)
    ?.map((member) => member.trim())
    .filter(Boolean);
  if (
    !o ||
    !name ||
    !github ||
    !members?.length ||
    !/^[\w.-]+\/[\w.-]+$/.test(github)
  )
    return undefined;
  return { name, github, members };
}

function parseConfig(text: string): OpenSessionConfig {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const cfg: OpenSessionConfig = {};

    const server = obj(raw.server);
    if (server) {
      cfg.server = defined({
        host: str(server.host),
        port: num(server.port),
        publicBaseUrl: str(server.publicBaseUrl),
        previewHost: str(server.previewHost),
        caddyAdmin: str(server.caddyAdmin),
      });
    }

    const ingress = obj(raw.ingress);
    if (ingress) {
      const rawExposure = str(ingress.exposure);
      const exposure: IngressExposure | undefined =
        rawExposure === "cloudflare" || rawExposure === "custom"
          ? rawExposure
          : undefined;
      cfg.ingress = defined({
        publicBaseUrl: str(ingress.publicBaseUrl),
        exposure,
        cloudflareTunnelId: str(ingress.cloudflareTunnelId),
      });
    }

    const paths = obj(raw.paths);
    if (paths) {
      cfg.paths = defined({
        claudeBin: str(paths.claudeBin),
        worktreesDir: str(paths.worktreesDir),
        mcpConfig: str(paths.mcpConfig),
      });
    }

    // Unknown values fall back to the default ("shared") but warn — a typo'd
    // "worktree" silently running sessions in the live checkout would defeat
    // the whole point of setting the flag. Parse results are cached by
    // file mtime (see getConfig), so this warns once per config change, not
    // once per read.
    if (raw.selfDev !== undefined) {
      if (raw.selfDev === "shared" || raw.selfDev === "worktree") {
        cfg.selfDev = raw.selfDev;
      } else {
        console.warn(
          `[config] invalid selfDev value ${JSON.stringify(raw.selfDev)} (expected "shared" or "worktree") — using "shared"`,
        );
      }
    }

    const repos = obj(raw.repos);
    if (repos) {
      const parsed: Record<string, RepoSection> = {};
      for (const [id, entry] of Object.entries(repos)) {
        const r = parseRepoSection(entry);
        if (r) parsed[id] = r;
      }
      cfg.repos = parsed;
    }

    const identity = obj(raw.identity);
    if (identity) {
      const section: IdentitySection = {};
      section.defaultTimezone = str(identity.defaultTimezone);
      if (Array.isArray(identity.team)) {
        section.team = identity.team
          .map(parseTeamMember)
          .filter((m): m is TeamMember => !!m);
      }
      if (Array.isArray(identity.reviewTeams)) {
        section.reviewTeams = identity.reviewTeams
          .map(parseReviewTeam)
          .filter((team): team is ReviewTeam => !!team);
      }
      const names = obj(identity.slackNames);
      if (names) {
        section.slackNames = Object.fromEntries(
          Object.entries(names).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>;
      }
      cfg.identity = section;
    }

    const storage = obj(raw.storage);
    const assets = obj(storage?.assets);
    if (assets) {
      const provider = str(assets.provider);
      cfg.storage = {
        assets: defined({
          provider:
            provider === "s3" || provider === "local"
              ? (provider as AssetStorageSection["provider"])
              : undefined,
          bucket: str(assets.bucket),
          region: str(assets.region),
          endpoint: str(assets.endpoint),
          prefix: str(assets.prefix),
          accessKeyId: str(assets.accessKeyId),
          secretAccessKey: str(assets.secretAccessKey),
          forcePathStyle: bool(assets.forcePathStyle),
        }),
      };
    }

    const integrations = obj(raw.integrations);
    if (integrations) cfg.integrations = integrations;
    const policy = obj(raw.policy);
    if (policy) {
      cfg.policy = defined({
        stripeConfirmTools: strArray(policy.stripeConfirmTools),
        automationDeniedTools: strArray(policy.automationDeniedTools),
        githubWriteOwners: strArray(policy.githubWriteOwners),
        githubBotLogins: strArray(policy.githubBotLogins),
      });
    }
    const organization = obj(raw.organization);
    if (organization) {
      cfg.organization = defined({
        name: str(organization.name),
      });
    }
    const persona = obj(raw.persona);
    if (persona) {
      cfg.persona = defined({
        name: str(persona.name),
        company: str(persona.company),
        product: str(persona.product),
      });
    }
    const branding = obj(raw.branding);
    if (branding) {
      cfg.branding = defined({
        productName: str(branding.productName),
        productMark: str(branding.productMark),
      });
    }

    return cfg;
  } catch {
    return {};
  }
}

// Read fresh per call, with an mtime/size guard so hot paths (the REPOS proxy
// in worktree.ts hits this on every property access) don't re-parse an
// unchanged file. Missing/unreadable/invalid file = {} = built-in defaults.
let cache: {
  path: string;
  mtimeMs: number;
  size: number;
  value: OpenSessionConfig;
} | null = null;

/** Raw config.json contents (typed, tolerant). Never throws. */
export function getConfig(): OpenSessionConfig {
  const path = configPath();
  try {
    const st = statSync(path);
    if (
      cache &&
      cache.path === path &&
      cache.mtimeMs === st.mtimeMs &&
      cache.size === st.size
    ) {
      return cache.value;
    }
    const value = parseConfig(readFileSync(path, "utf-8"));
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, value };
    return value;
  } catch {
    cache = null;
    return {};
  }
}

// ---------------------------------------------------------------------------
// Typed getters (env var → config.json → portable default)
// ---------------------------------------------------------------------------

export function configuredServer(): ResolvedServer {
  const s = getConfig().server || {};
  // PORT remains the stable TCP supervisor's public listener; only the
  // entrypoint consumes the child's private OPENSESSION_GATEWAY_BACKEND_PORT.
  const envPort = parseInt(process.env.PORT || "");
  const port = Number.isFinite(envPort) ? envPort : (s.port ?? 3850);
  const publicBaseUrl =
    process.env.OPENSESSION_UI_BASE ||
    s.publicBaseUrl ||
    `http://127.0.0.1:${port}`;
  const webhookBaseUrl =
    process.env.OPENSESSION_INGRESS_BASE ||
    getConfig().ingress?.publicBaseUrl ||
    publicBaseUrl;
  let publicHost = "127.0.0.1";
  try {
    publicHost = new URL(publicBaseUrl).hostname || publicHost;
  } catch {}
  return {
    host: process.env.HOST || s.host || "127.0.0.1",
    port,
    publicBaseUrl,
    webhookBaseUrl,
    // Portals authenticate with the OpenSession browser cookie. Defaulting to
    // the UI hostname keeps that cookie same-site across preview ports; an
    // unrelated machine/tailnet hostname would make every browser portal 401.
    previewHost: process.env.PREVIEW_HOST || s.previewHost || publicHost,
    caddyAdmin: s.caddyAdmin || "http://localhost:2019",
  };
}

export function configuredIngress(): ResolvedIngress {
  const ingress = getConfig().ingress || {};
  return {
    publicBaseUrl: (
      process.env.OPENSESSION_INGRESS_BASE ||
      ingress.publicBaseUrl ||
      ""
    ).replace(/\/+$/, ""),
    exposure: ingress.exposure || null,
    cloudflareTunnelId: ingress.cloudflareTunnelId || "",
  };
}

export function configuredPaths(): ResolvedPaths {
  const p = getConfig().paths || {};
  return {
    claudeBin:
      process.env.OPENSESSION_CLAUDE_BIN ||
      p.claudeBin ||
      Bun.which("claude") ||
      "claude",
    worktreesDir:
      process.env.OPENSESSION_WORKTREES_DIR ||
      p.worktreesDir ||
      // statePath, so a dev/demo instance's worktrees land in its own state
      // root instead of the operator's home. Unset ⇒ $HOME (unchanged).
      statePath(".opensession/worktrees"),
    mcpConfig:
      process.env.OPENSESSION_MCP_CONFIG ||
      p.mcpConfig ||
      `${OPENSESSION_ROOT}/mcp-config.json`,
  };
}

export type ResolvedAssetStorage =
  | { provider: "local" }
  | {
      provider: "s3";
      bucket: string;
      region: string;
      endpoint?: string;
      prefix: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

/** Session assets stay local unless an explicit, complete S3-compatible
 * backend is configured. An incomplete enabled backend fails loudly so assets
 * never spill back onto the disk the administrator meant to stop using. */
export function configuredAssetStorage(): ResolvedAssetStorage {
  const assets = getConfig().storage?.assets;
  if (!assets || assets.provider !== "s3") return { provider: "local" };
  const required = {
    bucket: assets.bucket?.trim(),
    accessKeyId: assets.accessKeyId?.trim(),
    secretAccessKey: assets.secretAccessKey?.trim(),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`S3 asset storage is missing ${missing.join(", ")}`);
  }
  return {
    provider: "s3",
    bucket: required.bucket!,
    region: assets.region?.trim() || "us-east-1",
    ...(assets.endpoint?.trim() ? { endpoint: assets.endpoint.trim() } : {}),
    prefix:
      assets.prefix?.trim().replace(/^\/+|\/+$/g, "") || "opensession-assets",
    accessKeyId: required.accessKeyId!,
    secretAccessKey: required.secretAccessKey!,
    forcePathStyle: assets.forcePathStyle === true,
  };
}

/**
 * How NEW sessions on a `sharedCheckout` repo get their working dir.
 * "shared" (the default, and the behavior with no config): sessions work
 * directly in the repo's live main checkout — the self-hosting workflow.
 * "worktree": the shared-checkout special case stops applying at
 * session-creation time and self-repo sessions get isolated per-branch
 * worktrees exactly like every other repo (see
 * sharedCheckoutForNewSessions in worktree.ts, the sole decision point).
 * Existing sessions keep whatever dir their session file records either way.
 */
export function configuredSelfDev(): SelfDevMode {
  return getConfig().selfDev || "shared";
}

/**
 * The repo registry. An explicit `repos` object is authoritative; without one,
 * a source checkout gets a portable self-repo so a first run is useful.
 */
export function configuredRepos(): Record<string, Repo> {
  const configured = getConfig().repos;
  const merged = configured ? {} : builtinRepos();
  for (const [id, entry] of Object.entries(configured || {})) {
    const base = merged[id];
    if (base) {
      merged[id] = { ...base, ...entry, id };
    } else {
      if (!entry.repo) continue; // a new repo needs a checkout path
      merged[id] = {
        id,
        label: entry.label || id,
        repo: entry.repo,
        wtPrefix: entry.wtPrefix || id,
        defaultBranch: entry.defaultBranch || "main",
        ghRepo: entry.ghRepo || "",
        ...defined({
          description: entry.description,
          host: entry.host,
          csRepo: entry.csRepo,
          sharedCheckout: entry.sharedCheckout,
          default: entry.default,
          icon: entry.icon,
          iconSource: entry.iconSource,
          color: entry.color,
          previewCommand: entry.previewCommand,
          worktreeSetup: entry.worktreeSetup,
          depsInstall: entry.depsInstall,
          prCache: entry.prCache,
          prCacheOpenLimit: entry.prCacheOpenLimit,
          prCacheRecentLimit: entry.prCacheRecentLimit,
          warmCachePaths: entry.warmCachePaths,
          previewAwsProfile: entry.previewAwsProfile,
          deploymentTracking: entry.deploymentTracking,
          securityInstructions: entry.securityInstructions,
        }),
      };
    }
  }
  return merged;
}

/**
 * Repo ids that have been renamed: former id → the one it is registered under
 * now. Same idea as LEGACY_SESSIONS_DIR_NAMES in paths.ts, one level up: a
 * stored repo id is a foreign key into the registry, so a rename leaves every
 * record written before it pointing at a repo that no longer exists. Those
 * records do not fail loudly, they split off: the sidebar draws a second band
 * for the dangling id, under the same display name and without the repo's
 * icon, and `getRepo` throws for anything that tries to resolve a checkout
 * from it.
 *
 * Only Open Session's own rename is listed, because that is the one this
 * codebase performed. An instance that renames a repo in its own config adds
 * the old id here.
 */
const RENAMED_REPO_IDS: Record<string, string> = {
  // Open Session was called Backstage until 2026-08-05.
  backstage: "opensession",
};

/**
 * The registered id a stored repo id means. Apply it wherever a repo id is
 * read back from persisted data; ids stay canonical from there on, so nothing
 * downstream has to know a rename ever happened.
 */
export function canonicalRepoId(id: string): string {
  const renamed = RENAMED_REPO_IDS[id];
  // The old name wins only while it is genuinely gone: an instance that
  // registers a repo under it again owns that id, and its records are its own.
  return renamed && !configuredRepos()[id] ? renamed : id;
}

/**
 * The real repository shown by default in the New-session picker. Retired or
 * missing values fall back to the repository registry's explicit default.
 */
export function newSessionRepoDefault(): string {
  const repos = configuredRepos();
  const configured = (getConfig().newSessionRepo || "").trim();
  if (configured in repos) return configured;
  return (
    Object.values(repos).find((repo) => repo.default)?.id ||
    Object.values(repos)[0]?.id ||
    "none"
  );
}

/** The instance's operational default repository. */
export function defaultRepo(): Repo {
  const repos = configuredRepos();
  const repo =
    Object.values(repos).find((r) => r.default) || Object.values(repos)[0];
  if (!repo) throw new Error("No repositories are registered");
  return repo;
}

/**
 * The agent's name as rendered to users and models (system prompts, Slack
 * greetings, confirm cards, health payloads). NOT for protocol identifiers —
 * `opensession-*` MCP server ids and ===OPENSESSION-SUMMARY=== markers stay
 * literal (renaming those breaks running sessions).
 */
export function personaName(): string {
  return getConfig().persona?.name || "Assistant";
}

/**
 * What the platform itself is called in user-facing copy (page titles,
 * headers). Two words by default; NOT for paths/ids, which stay one word:
 * state dirs, env vars, package/MCP ids, `bks-` prefixes and service/socket
 * names are literals and never follow the wordmark.
 */
export function productName(): string {
  return getConfig().branding?.productName || "Open Session";
}

/** Short brand monogram for visual brand-mark contexts (logo chip, favicon);
 *  falls back to the full product name. */
export function productMark(): string {
  return getConfig().branding?.productMark || productName();
}

/** The company or team sharing this instance. A fresh install falls back to
 * the product name until an administrator names the organization. */
export function organizationName(): string {
  return getConfig().organization?.name || productName();
}

export interface IdentityPatch {
  /** Trimmed; empty string deletes the key so the built-in default applies. */
  personaName?: string;
  productName?: string;
  productMark?: string;
}

/**
 * Write persona.name / branding.productName / branding.productMark into
 * config.json (Settings → General). Operates on the raw parsed JSON — not the
 * normalized OpenSessionConfig — so every other key, including ones this
 * module doesn't model, survives byte-for-byte in structure. Refuses to touch
 * a file that exists but doesn't parse: overwriting a hand-edited file with a
 * syntax error would silently destroy it.
 */
export function updateIdentityConfig(patch: IdentityPatch): void {
  const path = configPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path} is not a JSON object`);
    }
    raw = parsed as Record<string, unknown>;
  }
  const setOrDelete = (
    section: "persona" | "branding",
    key: string,
    value: string | undefined,
  ) => {
    if (value === undefined) return;
    const cur = obj(raw[section]) || {};
    const trimmed = value.trim();
    if (trimmed) cur[key] = trimmed;
    else delete cur[key];
    if (Object.keys(cur).length) raw[section] = cur;
    else delete raw[section];
  };
  setOrDelete("persona", "name", patch.personaName);
  setOrDelete("branding", "productName", patch.productName);
  setOrDelete("branding", "productMark", patch.productMark);
  writeFileAtomic(path, JSON.stringify(raw, null, 2) + "\n");
}

/**
 * Identity roster for user-mappings.ts. Missing/empty identity means no
 * instance-specific attribution or per-user integration access.
 */
export function configuredIdentity(): ResolvedIdentity {
  const id = getConfig().identity;
  if (!id)
    return {
      team: [],
      reviewTeams: [],
      slackNames: {},
      defaultTimezone: "UTC",
    };
  return {
    team: id.team ?? [],
    reviewTeams: id.reviewTeams ?? [],
    slackNames: id.slackNames ?? {},
    defaultTimezone: id.defaultTimezone ?? "UTC",
  };
}

export function personaCompany(): string {
  return getConfig().persona?.company || "your organization";
}

export function personaProduct(): string {
  return getConfig().persona?.product || "your product";
}

/** Owners represented by registered GitHub repos unless policy narrows them. */
export function githubWriteOwners(): string[] {
  const configured = getConfig().policy?.githubWriteOwners;
  if (configured)
    return [...new Set(configured.map((owner) => owner.toLowerCase()))];
  return [
    ...new Set(
      Object.values(configuredRepos())
        .map((repo) => repo.ghRepo.split("/")[0]?.toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function githubBotLogins(): string[] {
  // Resolve the App slug env-over-config, mirroring githubAppIdentity() — an App
  // set entirely through OPENSESSION_GITHUB_APP_SLUG (no appSlug in the file)
  // must still contribute its bot identity.
  const configSlug = configuredIntegration("github").appSlug;
  const appSlug =
    process.env.OPENSESSION_GITHUB_APP_SLUG?.trim() ||
    (typeof configSlug === "string" ? configSlug.trim() : "");
  return [
    ...new Set(
      [
        ...(getConfig().policy?.githubBotLogins || []),
        // The App authors comments as "<app-slug>[bot]". Recognise it as ours
        // so the agent never treats its own App-posted comments as human
        // replies to answer.
        ...(appSlug ? [`${appSlug}[bot]`] : []),
      ].map((login) => login.toLowerCase()),
    ),
  ];
}

/** Is `login` one of our bot identities? Membership over the whole
 *  githubBotLogins() set, not equality with the primary — the App bot and any
 *  policy aliases can all be "ours", so identity checks (own
 *  threads, replies, review authorship, webhook senders) must match any of
 *  them, not just the first. Case-insensitive. */
export function isGithubBotLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  return githubBotLogins().includes(login.toLowerCase());
}

/** Tolerant access for integration-specific modules. Integration schemas can
 * evolve independently without making the core loader reject unknown keys. */
export function configuredIntegration(name: string): Record<string, unknown> {
  const value = getConfig().integrations?.[name];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Plain workspace id (`integrations.plain.workspaceId`) for deep links into
 *  app.plain.com. Null when unset — consumers hide their "open in Plain"
 *  affordances. */
export function plainWorkspaceId(): string | null {
  const v = configuredIntegration("plain").workspaceId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Plain GraphQL endpoint (`integrations.plain.apiUrl`). */
export function plainApiUrl(): string {
  const v = configuredIntegration("plain").apiUrl;
  return typeof v === "string" && v.trim()
    ? v.trim()
    : "https://core-api.uk.plain.com/graphql/v1";
}

/** code.storage host settings (`integrations.codeStorage`), resolved. */
export interface CodeStorageConfig {
  /** Organization identifier — the JWT `iss` and the remote-host subdomain. */
  org: string;
  /** PKCS8 PEM private key used to sign JWTs (ES256 or RS256). */
  privateKeyPath: string;
  /** REST base including the `/api` suffix. */
  apiBase: string;
  /** HMAC secret for inbound `POST /codestorage/webhook` deliveries. */
  webhookSecret?: string;
}

/**
 * Null until both `org` and `privateKeyPath` are set — every code.storage
 * code path (JWT minting, REST client, credential helper) is inert then.
 * The lowercase `integrations.codestorage` spelling is accepted too, matching
 * the registry id.
 */
export function codeStorageConfig(): CodeStorageConfig | null {
  const raw = {
    ...configuredIntegration("codestorage"),
    ...configuredIntegration("codeStorage"),
  };
  const org = str(raw.org);
  const privateKeyPath = str(raw.privateKeyPath);
  if (!org || !privateKeyPath) return null;
  const apiBase = str(raw.apiBase) || `https://api.${org}.code.storage/api`;
  const webhookSecret = str(raw.webhookSecret);
  return {
    org,
    privateKeyPath,
    apiBase: apiBase.replace(/\/+$/, ""),
    ...(webhookSecret ? { webhookSecret } : {}),
  };
}
