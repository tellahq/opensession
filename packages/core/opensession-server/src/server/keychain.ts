/**
 * Keychain — per-person credentials with an ask→grant flow, modelled on
 * yc-software/qm's keychain (MIT) and built on our human-asks transport.
 *
 * Today a credential is either instance-wide (~/.opensession.env, mcp-config
 * `env`) or absent. There is no way for a session to say "I need this teammate's
 * Vercel token for this one task" and for its owner to say "fine, once". This
 * module adds exactly that:
 *
 *   credential — owned by a PERSON (identity roster name). The secret lives
 *                here 0600 and is never returned by any API or tool.
 *   ask        — a session's request to borrow one: purpose + once/standing.
 *                Any teammate's session may ask for any credential. It is
 *                delivered to the owner through human-asks (Slack DM with
 *                Approve once / Approve standing / Decline buttons) and
 *                listed for them in Settings → Account, where they can
 *                answer it too. Only the owner can answer: never as a card
 *                in the session, which anyone watching could click.
 *   grant      — the approval: scoped to the REQUESTING SESSION only,
 *                once (single broker call, 1h) or standing (7d), revocable,
 *                audited. A third mode, run, approves one named script for
 *                bulk use through a per-run proxy (keychain-runs.ts); the
 *                owner sees the command and the call cap before approving.
 *
 * Delivery is broker-only: the agent never sees the secret. It calls the
 * keychain's call_credential tool (keychain-broker.ts), which runs inside
 * this process, injects the credential's header and makes the request to
 * the credential's host, constrained by its allowedMethods /
 * allowedPathPrefixes, with the secret scrubbed from what comes back. The
 * tool is bound to the calling run's session by the run-rpc token, so a
 * grant only works in the session it was issued to: a grant id copied out
 * of a transcript is not a credential anywhere else. A credential marked
 * statusOnly returns just the HTTP status, for keys whose API might echo
 * or encode the secret in a way scrubbing can't catch.
 *
 * Trust boundary: the opensession-keychain MCP server is interactive-only
 * (same bar as opensession-humans — never automation runs), so untrusted
 * ticket text cannot social-engineer an owner with a plausible "purpose".
 * Registration is HTTP-only (routes/keychain.ts, web-auth gated): a secret
 * typed into a session prompt would land in the transcript. The
 * register_credential tool (credential-registrations.ts) keeps that rule: the
 * agent supplies only metadata, and the session's own driver pastes the
 * secret into a card that posts straight to that HTTP path.
 *
 * Logins are the one exception to "the agent never sees the secret". A
 * credential of kind "login" holds a sign-in page, a username and a password
 * for a test account. A password has to be typed into a page the agent's
 * browser drives, and the agent can read a field it typed into, so no relay
 * can keep it hidden. Its asks say so plainly and offer only Release
 * password or Decline. An approval mints a single-use "release" grant: the
 * use_login tool writes the password to a short-lived 0600 file in the
 * session's own workspace (keychain-logins.ts), never into a tool result or
 * the transcript. A login is never usable through call_credential or a
 * scripted run, and an API credential is never released.
 *
 * Stated limitation: the store is a 0600 file owned by the service user,
 * which agent shells also run as (and which may have root on the host), so
 * nothing here stops a local agent that deliberately reads the store or the
 * process. The keychain prevents accidental exposure and audits use; see
 * "Keychain credentials" in docs/security-model.md.
 */

import { stateDir } from "./paths";
import { existsSync, readFileSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { writeJsonAtomic, writeJsonAtomicAsync } from "./shared/atomic-write";
import { audit, auditAsync } from "./audit";
import { resolveTeammate } from "./shared/user-mappings";
import {
  cancelAsk,
  getAsk,
  registerAsk,
  registerAskDomainHandler,
  resolveAskAsPerson,
  type HumanAsk,
} from "./human-asks";

/**
 * Resolved per call, never captured at module load. Tests point
 * OPENSESSION_KEYCHAIN_STORE at a temp file, and this module is imported
 * transitively (interactive-mcp → keychain-tools → here) by other suites — a
 * const captured at first import would silently ignore the override and let a
 * test suite write to, or truncate, the real keychain.
 */
function storePath(): string {
  return process.env.OPENSESSION_KEYCHAIN_STORE || stateDir("keychain.json");
}

const ONCE_GRANT_TTL_MS = 60 * 60 * 1000;
/** How long an approved scripted run may wait to be started. The run itself
 *  then lives until its own deadline (keychain-runs.ts). */
const RUN_GRANT_START_TTL_MS = 60 * 60 * 1000;
/** How long one owner's approval of a multi-credential run waits for the
 *  others. Once the last owner approves, every grant of the run gets the
 *  ordinary start window from that moment. */
const RUN_GROUP_WAIT_TTL_MS = 24 * 60 * 60 * 1000;
const STANDING_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Terminal asks/grants older than this are pruned on load. */
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type GrantMode = "once" | "standing" | "run" | "release";

/** "api" (the default, stored as absent) is a header the broker injects;
 *  "login" is a username and password for a sign-in page. */
export type CredentialKind = "api" | "login";

/** What the owner approves for a scripted run: this exact command, and at
 *  most this many proxied calls with this credential. */
export interface KeychainScriptedRun {
  command: string;
  maxCalls: number;
  /** Set when the run uses several credentials. The same on every ask and
   *  grant of that run, so a run starts only with grants from one request,
   *  once every credential's owner approved. */
  group?: KeychainRunGroup;
}

export interface KeychainRunGroup {
  id: string;
  /** Every credential in the run, in the order asked, with its own cap. */
  members: KeychainRunMember[];
}

export interface KeychainRunMember {
  service: string;
  host: string;
  owner: string;
  maxCalls: number;
}

export const MAX_RUN_COMMAND_CHARS = 2000;
export const MAX_RUN_CALLS = 1_000_000;
export const MAX_RUN_CREDENTIALS = 8;

/** The environment variable holding a credential's proxy URL in a scripted
 *  run: KEYCHAIN_PROXY_URL_ and the service slug, upper-cased, with every
 *  other character as _. */
export function proxyEnvName(service: string): string {
  return `KEYCHAIN_PROXY_URL_${service.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export interface KeychainCredential {
  id: string;
  /** Owner's roster first name — the person who approves asks for it. */
  owner: string;
  /** Lookup + display key, e.g. "vercel", "ahrefs". Unique per keychain. */
  service: string;
  description?: string;
  /** Absent for an API credential. */
  kind?: "login";
  /** A login's sign-in page. Its host is `host`. */
  loginUrl?: string;
  /** A login's username. Not secret: shown to the agent and to teammates. */
  username?: string;
  /** Broker target host (https assumed), e.g. "api.vercel.com". For a
   *  login, the sign-in page's host. */
  host: string;
  /** How the secret rides the proxied request. Default Authorization: Bearer. */
  injection?: { header?: string; scheme?: string };
  /** Empty/undefined = all methods. */
  allowedMethods?: string[];
  /** Empty/undefined = all paths. */
  allowedPathPrefixes?: string[];
  /** Calls return only the HTTP status, never headers or body. */
  statusOnly?: boolean;
  secret: string;
  createdAt: string;
  updatedAt: string;
}

/** Everything about a credential except the secret — the only shape any
 *  list/API/tool ever returns. */
export type KeychainCredentialMeta = Omit<KeychainCredential, "secret">;

export interface KeychainGrant {
  /** The id IS the broker bearer token — unguessable, scoped, expiring. */
  id: string;
  credentialId: string;
  owner: string;
  /** Audience: only this opensession session was granted anything. */
  sessionId: string;
  requestedBy: string;
  purpose: string;
  mode: GrantMode;
  status: "active" | "used" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
  askId?: string;
  /** Set for mode "run": the script the owner approved. */
  run?: KeychainScriptedRun;
  /** The run that claimed this grant; a run grant starts one run only. */
  runId?: string;
  /** Calls the run made with this grant, saved as it goes, so a run cut off
   *  by a server restart can say how far it got. */
  runCalls?: number;
  /** The run was cut off by a server restart, not ended by its own exit. */
  interrupted?: true;
}

export interface KeychainAskRecord {
  id: string;
  credentialId: string;
  owner: string;
  sessionId: string;
  requestedBy: string;
  purpose: string;
  requestedMode: GrantMode;
  /** Set when the ask is for a scripted run (requestedMode "run"). */
  run?: KeychainScriptedRun;
  status: "pending" | "approved" | "declined" | "expired" | "cancelled";
  /** The human-asks transport record carrying the owner's buttons. */
  humanAskId?: string;
  grantId?: string;
  createdAt: string;
  resolvedAt?: string;
  note?: string;
}

interface Stored {
  credentials: KeychainCredential[];
  grants: KeychainGrant[];
  asks: KeychainAskRecord[];
}

const g = globalThis as any;
const credentials: Map<string, KeychainCredential> =
  (g.__keychainCredentials ??= new Map());
const grants: Map<string, KeychainGrant> = (g.__keychainGrants ??= new Map());
const keychainAsks: Map<string, KeychainAskRecord> = (g.__keychainAsks ??=
  new Map());
/** The path we last loaded from — a change (only tests do this) reloads. */
let loadedFrom: string | null = null;

/** Bumped on every in-memory change that is persisted, so an async write
 *  that raced a newer one knows to write again. */
let revision = 0;

function snapshot(): Stored {
  return {
    credentials: [...credentials.values()],
    grants: [...grants.values()],
    asks: [...keychainAsks.values()],
  };
}

function persist(): void {
  revision++;
  const path = storePath();
  writeJsonAtomic(path, snapshot());
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort — the file holds secrets, but a chmod failure must not
    // lose the write (the box is single-tenant either way)
  }
}

let asyncWrites: Promise<void> = Promise.resolve();

/**
 * Persist without blocking the calling thread, for request handlers on the
 * gateway. Writes are serialized, and each one re-writes if the store changed
 * while it was in flight (including through a synchronous persist), so the
 * file always ends on the latest state. The temp file is created 0600, so
 * the secret-bearing file is never readable by others, even briefly.
 */
function persistAsync(): Promise<void> {
  revision++;
  const write = asyncWrites.then(async () => {
    let written: number;
    do {
      written = revision;
      await writeJsonAtomicAsync(storePath(), snapshot(), true, 0o600);
    } while (written !== revision);
  });
  asyncWrites = write.catch(() => {});
  return write;
}

function ingest(data: Stored): void {
  const cutoff = Date.now() - TERMINAL_RETENTION_MS;
  for (const c of data.credentials || []) credentials.set(c.id, c);
  for (const gr of data.grants || []) {
    if (gr.status !== "active" && new Date(gr.createdAt).getTime() < cutoff)
      continue;
    // A claimed run grant's proxy lived in the process that loaded it last.
    // That process is gone, so the run is over.
    if (gr.mode === "run" && gr.runId && gr.status === "active") {
      gr.status = "used";
      gr.usedAt ??= new Date().toISOString();
      gr.interrupted = true;
    }
    grants.set(gr.id, gr);
  }
  for (const a of data.asks || []) {
    if (a.status !== "pending" && new Date(a.createdAt).getTime() < cutoff)
      continue;
    keychainAsks.set(a.id, a);
  }
}

function load(): void {
  const path = storePath();
  if (loadedFrom === path) return;
  loadedFrom = path;
  if (!existsSync(path)) return;
  try {
    ingest(JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    console.error("[keychain] failed to load store:", e);
  }
}

/** Async counterpart of load(), for request handlers on the gateway. After
 *  it resolves, the synchronous load() inside the store's functions is a
 *  no-op. */
export async function ensureKeychainLoaded(): Promise<void> {
  const path = storePath();
  if (loadedFrom === path) return;
  let raw: string | null = null;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e: any) {
    if (e?.code !== "ENOENT")
      console.error("[keychain] failed to read store:", e);
  }
  // Another caller may have loaded while this one awaited.
  if (loadedFrom === path) return;
  loadedFrom = path;
  if (raw === null) return;
  try {
    ingest(JSON.parse(raw));
  } catch (e) {
    console.error("[keychain] failed to load store:", e);
  }
}

function meta(c: KeychainCredential): KeychainCredentialMeta {
  const { secret: _secret, ...rest } = c;
  return rest;
}

/** Lazy expiry — checked on every read/use, no sweeper to keep alive. */
function settleExpiry(gr: KeychainGrant): KeychainGrant {
  if (gr.status === "active" && Date.now() > new Date(gr.expiresAt).getTime()) {
    gr.status = "expired";
    grants.set(gr.id, gr);
    persist();
    audit({
      kind: "keychain_grant_expired",
      grant_id: gr.id,
      credential_id: gr.credentialId,
    });
  }
  return gr;
}

const norm = (s: string) => s.trim().toLowerCase();

/** The roster first name for an identity, or the trimmed input as-is. */
function ownerName(user: string): string {
  return resolveTeammate(user)?.name || user.trim();
}

function sameOwner(a: string, b: string): boolean {
  return norm(ownerName(a)) === norm(ownerName(b));
}

// ── Credentials ──────────────────────────────────────────────────────────────

export interface AddCredentialInput {
  owner: string;
  service: string;
  /** Required for an API credential; a login takes it from loginUrl. */
  host?: string;
  secret: string;
  description?: string;
  kind?: CredentialKind;
  loginUrl?: string;
  username?: string;
  injection?: { header?: string; scheme?: string };
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
  statusOnly?: boolean;
}

export type CredentialSpec = Omit<AddCredentialInput, "owner" | "secret">;

export interface NormalizedCredentialSpec {
  service: string;
  host: string;
  description?: string;
  kind?: "login";
  loginUrl?: string;
  username?: string;
  injection?: { header?: string; scheme?: string };
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
  statusOnly?: boolean;
}

const HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/** A credential host as stored: lower-case, without scheme or path. */
export function normalizeCredentialHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");
}

/** A login's sign-in page as stored, or an error safe to show the caller. */
export function normalizeLoginUrl(raw: string | undefined): URL {
  let url: URL;
  try {
    url = new URL((raw || "").trim());
  } catch {
    throw new Error("loginUrl must be a full https:// URL of the sign-in page");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("loginUrl must be a full https:// URL of the sign-in page");
  url.hash = "";
  return url;
}

/** The host a spec will be stored under: a login's sign-in page host, else
 *  the normalized API host. Throws like normalizeLoginUrl. */
export function credentialSpecHost(spec: CredentialSpec): string {
  return spec.kind === "login"
    ? normalizeLoginUrl(spec.loginUrl).hostname
    : normalizeCredentialHost(spec.host || "");
}

// Model-authored or pasted text shown to a person: no control or
// bidi-override characters that could make it say something else.
const UNSAFE_DISPLAY_CHARS = /[\x00-\x1f\x7f‪-‮⁦-⁩]/;

/**
 * Validate and normalize everything about a credential except its owner and
 * secret. Throws with a message safe to show the caller. Shared by the HTTP
 * registration route and the register_credential tool, which checks a spec
 * before it asks the owner for the secret. Also rejects a service slug that
 * is already taken, since slugs are how asks name a credential.
 */
export function normalizeCredentialSpec(
  input: CredentialSpec,
): NormalizedCredentialSpec {
  load();
  const service = norm(input.service);
  if (!service || !/^[a-z0-9][a-z0-9._-]*$/.test(service)) {
    throw new Error(
      "service must be a short lowercase slug (letters, digits, . _ -)",
    );
  }
  if (input.kind === "login") return normalizeLoginSpec(input, service);
  if (input.kind !== undefined && input.kind !== "api")
    throw new Error('kind must be "api" or "login"');
  if (input.loginUrl !== undefined || input.username !== undefined)
    throw new Error("loginUrl and username belong to a login credential");
  const host = normalizeCredentialHost(input.host || "");
  if (!host || !/^[a-z0-9][a-z0-9.-]*$/.test(host) || host.includes(":")) {
    throw new Error("host must be a bare host name (no scheme, port, or path)");
  }
  if ([...credentials.values()].some((c) => c.service === service)) {
    throw new Error(`a credential for service "${service}" already exists`);
  }
  const methods = (input.allowedMethods || [])
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
  for (const m of methods) {
    if (!HTTP_METHODS.has(m)) throw new Error(`unknown HTTP method: ${m}`);
  }
  const prefixes = (input.allowedPathPrefixes || [])
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of prefixes) {
    if (!p.startsWith("/"))
      throw new Error(`path prefix must start with /: ${p}`);
  }
  let injection: NormalizedCredentialSpec["injection"];
  if (input.injection) {
    const { header, scheme } = input.injection;
    if (header !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(header))
      throw new Error("injection header must be a plain header name");
    if (scheme !== undefined && !/^[A-Za-z0-9-]{0,32}$/.test(scheme))
      throw new Error("injection scheme must be a single word, or empty");
    injection = {
      ...(header !== undefined ? { header } : {}),
      ...(scheme !== undefined ? { scheme } : {}),
    };
  }
  const description = input.description?.trim();
  return {
    service,
    host,
    ...(description ? { description } : {}),
    ...(injection && Object.keys(injection).length ? { injection } : {}),
    ...(methods.length ? { allowedMethods: methods } : {}),
    ...(prefixes.length ? { allowedPathPrefixes: prefixes } : {}),
    ...(input.statusOnly === true ? { statusOnly: true } : {}),
  };
}

function normalizeLoginSpec(
  input: CredentialSpec,
  service: string,
): NormalizedCredentialSpec {
  if (
    input.injection ||
    input.allowedMethods?.length ||
    input.allowedPathPrefixes?.length ||
    input.statusOnly
  )
    throw new Error(
      "a login has no header, method, path or status-only settings: it is typed into its sign-in page",
    );
  const url = normalizeLoginUrl(input.loginUrl);
  if (
    input.host !== undefined &&
    input.host.trim() &&
    normalizeCredentialHost(input.host) !== url.hostname
  )
    throw new Error("host must match the sign-in page's host, or be omitted");
  const username = input.username?.trim() || "";
  if (!username || username.length > 200 || UNSAFE_DISPLAY_CHARS.test(username))
    throw new Error("a login needs a username of at most 200 characters");
  if ([...credentials.values()].some((c) => c.service === service))
    throw new Error(`a credential for service "${service}" already exists`);
  const description = input.description?.trim();
  return {
    service,
    host: url.hostname,
    kind: "login",
    loginUrl: url.toString(),
    username,
    ...(description ? { description } : {}),
  };
}

/** Validate and insert, without persisting. Synchronous from the check to
 *  the insert, so two concurrent adds cannot both take one service slug. */
function insertCredential(input: AddCredentialInput): KeychainCredential {
  const spec = normalizeCredentialSpec(input);
  if (!input.secret.trim()) throw new Error("secret is empty");
  const now = new Date().toISOString();
  const cred: KeychainCredential = {
    id: `kc-${crypto.randomUUID()}`,
    owner: ownerName(input.owner),
    ...spec,
    // A password may begin or end with a space; an API token never does.
    secret: spec.kind === "login" ? input.secret : input.secret.trim(),
    createdAt: now,
    updatedAt: now,
  };
  credentials.set(cred.id, cred);
  return cred;
}

function auditAdded(cred: KeychainCredential): KeychainCredentialMeta {
  audit({
    kind: "keychain_credential_added",
    credential_id: cred.id,
    owner: cred.owner,
    service: cred.service,
    host: cred.host,
    ...(cred.kind ? { credential_kind: cred.kind } : {}),
  });
  return meta(cred);
}

export function addCredential(
  input: AddCredentialInput,
): KeychainCredentialMeta {
  const cred = insertCredential(input);
  persist();
  return auditAdded(cred);
}

/** addCredential for request handlers: loads and persists asynchronously so
 *  the gateway thread never blocks on the store. If the write fails, the
 *  credential is taken back out of memory and the error propagates. */
export async function addCredentialAsync(
  input: AddCredentialInput,
): Promise<KeychainCredentialMeta> {
  await ensureKeychainLoaded();
  const cred = insertCredential(input);
  try {
    await persistAsync();
  } catch (error) {
    credentials.delete(cred.id);
    await persistAsync().catch(() => {});
    // A filesystem error names the store path, never the secret.
    console.error("[keychain] failed to save credential:", error);
    throw new Error("couldn't write the keychain store");
  }
  return auditAdded(cred);
}

export function deleteCredential(id: string, by: string): boolean {
  load();
  const cred = credentials.get(id);
  if (!cred) return false;
  if (!sameOwner(cred.owner, by))
    throw new Error("only the credential's owner can delete it");
  credentials.delete(id);
  // A deleted credential takes its live grants with it — the broker would
  // otherwise 404 on the credential with an "active" grant lying around.
  const revoked: string[] = [];
  for (const gr of grants.values()) {
    if (gr.credentialId === id && gr.status === "active") {
      gr.status = "revoked";
      gr.revokedAt = new Date().toISOString();
      grants.set(gr.id, gr);
      revoked.push(gr.id);
    }
  }
  persist();
  for (const grantId of revoked) notifyRevoked(grantId);
  audit({ kind: "keychain_credential_deleted", credential_id: id, by });
  return true;
}

export function listCredentials(): KeychainCredentialMeta[] {
  load();
  return [...credentials.values()].map(meta);
}

export function findCredential(
  ref: string,
): KeychainCredentialMeta | undefined {
  load();
  const key = norm(ref);
  const cred =
    credentials.get(ref) ||
    [...credentials.values()].find((c) => c.service === key);
  return cred ? meta(cred) : undefined;
}

// ── Grants ───────────────────────────────────────────────────────────────────

export function listGrants(opts?: {
  sessionId?: string;
  owner?: string;
}): KeychainGrant[] {
  load();
  return [...grants.values()]
    .map(settleExpiry)
    .filter(
      (gr) =>
        (!opts?.sessionId || gr.sessionId === opts.sessionId) &&
        (!opts?.owner || sameOwner(gr.owner, opts.owner)),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const revokedListeners: Set<(grantId: string) => void> =
  (g.__keychainRevokedListeners ??= new Set());

/** Called with a grant's id when it is revoked, directly or by deleting its
 *  credential, so a running scripted run can end at once. */
export function onGrantRevoked(listener: (grantId: string) => void): void {
  revokedListeners.add(listener);
}

function notifyRevoked(grantId: string): void {
  for (const listener of revokedListeners) {
    try {
      listener(grantId);
    } catch (e) {
      console.error("[keychain] revocation listener failed:", e);
    }
  }
}

export function revokeGrant(
  id: string,
  by: string,
): { ok: true } | { error: string } {
  load();
  const gr = grants.get(id);
  if (!gr) return { error: "no such grant" };
  settleExpiry(gr);
  if (gr.status !== "active") return { error: `grant is already ${gr.status}` };
  // The owner lent it, the requester borrowed it — either may end it.
  if (!sameOwner(gr.owner, by) && norm(gr.requestedBy) !== norm(by)) {
    return { error: "only the grant's owner or requester can revoke it" };
  }
  gr.status = "revoked";
  gr.revokedAt = new Date().toISOString();
  grants.set(gr.id, gr);
  persist();
  audit({
    kind: "keychain_grant_revoked",
    grant_id: id,
    credential_id: gr.credentialId,
    by,
  });
  notifyRevoked(id);
  return { ok: true };
}

function mintGrant(ask: KeychainAskRecord, mode: GrantMode): KeychainGrant {
  const now = Date.now();
  const gr: KeychainGrant = {
    id: `kg-${crypto.randomUUID()}`,
    credentialId: ask.credentialId,
    owner: ask.owner,
    sessionId: ask.sessionId,
    requestedBy: ask.requestedBy,
    purpose: ask.purpose,
    mode,
    status: "active",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(
      now +
        (mode === "once" || mode === "release"
          ? ONCE_GRANT_TTL_MS
          : mode === "run"
            ? ask.run?.group
              ? RUN_GROUP_WAIT_TTL_MS
              : RUN_GRANT_START_TTL_MS
            : STANDING_GRANT_TTL_MS),
    ).toISOString(),
    askId: ask.id,
    ...(mode === "run" && ask.run ? { run: { ...ask.run } } : {}),
  };
  grants.set(gr.id, gr);
  persist();
  audit({
    kind: "keychain_grant_minted",
    grant_id: gr.id,
    credential_id: gr.credentialId,
    session_id: gr.sessionId,
    mode,
    owner: gr.owner,
  });
  return gr;
}

/**
 * Test seam: mint a grant without the human-asks transport, so the lifecycle
 * that carries the security properties (once-consumption, expiry, revocation,
 * method/path enforcement) is testable without sending a real Slack DM.
 * Never call outside tests — a grant minted here had no owner approval.
 */
export function __mintGrantForTest(input: {
  credentialId: string;
  sessionId: string;
  requestedBy: string;
  mode: GrantMode;
  expiresAt?: string;
  run?: KeychainScriptedRun;
}): KeychainGrant {
  load();
  const gr = mintGrant(
    {
      id: `ka-test-${crypto.randomUUID()}`,
      credentialId: input.credentialId,
      owner: credentials.get(input.credentialId)?.owner || "test",
      sessionId: input.sessionId,
      requestedBy: input.requestedBy,
      purpose: "test",
      requestedMode: input.mode,
      ...(input.run ? { run: input.run } : {}),
      status: "approved",
      createdAt: new Date().toISOString(),
    },
    input.mode,
  );
  if (input.expiresAt) {
    gr.expiresAt = input.expiresAt;
    grants.set(gr.id, gr);
    persist();
  }
  return gr;
}

// ── The broker's server side ────────────────────────────────────────────────

export interface BrokerUse {
  credential: KeychainCredential;
  grant: KeychainGrant;
}

/**
 * Validate a broker call and — for a once grant — consume it. Returns an
 * error string (safe to show the caller) or the credential+grant to use.
 * Consuming BEFORE the upstream call is deliberate: a once grant whose
 * upstream fetch fails is spent, not retryable — err on the side of the
 * owner's intent.
 */
export function consumeGrantForBroker(
  grantId: string,
  sessionId: string,
  method: string,
  path: string,
): BrokerUse | { error: string; status: number } {
  load();
  const gr = grants.get(grantId);
  // A grant from another session is reported exactly like a missing one.
  if (!gr || gr.sessionId !== sessionId)
    return { error: "unknown grant", status: 404 };
  settleExpiry(gr);
  if (gr.status !== "active")
    return { error: `grant is ${gr.status}`, status: 403 };
  // A run grant is used only through its run's proxy (useRunGrant).
  if (gr.mode === "run")
    return {
      error:
        "this grant is for a scripted run; start it with run_with_credential",
      status: 403,
    };
  const cred = credentials.get(gr.credentialId);
  if (!cred) return { error: "credential no longer exists", status: 404 };
  // A password is typed into its sign-in page, never sent as a header.
  if (gr.mode === "release" || cred.kind === "login")
    return {
      error: "this credential is a login; use it with use_login",
      status: 403,
    };
  const refusal = ceilingRefusal(cred, method, path);
  if (refusal) return { error: refusal, status: 403 };
  if (gr.mode === "once") {
    gr.status = "used";
    gr.usedAt = new Date().toISOString();
    grants.set(gr.id, gr);
    persist();
  }
  return { credential: cred, grant: gr };
}

/** Why the credential's method/path ceiling refuses a call, or null. `path`
 *  must already be parsed and normalized. */
function ceilingRefusal(
  cred: KeychainCredential,
  method: string,
  path: string,
): string | null {
  const m = method.toUpperCase();
  if (cred.allowedMethods?.length && !cred.allowedMethods.includes(m))
    return `method ${m} is not allowed for this credential (allowed: ${cred.allowedMethods.join(", ")})`;
  if (
    cred.allowedPathPrefixes?.length &&
    !cred.allowedPathPrefixes.some((p) => path.startsWith(p))
  )
    return `path is outside this credential's allowed prefixes (${cred.allowedPathPrefixes.join(", ")})`;
  return null;
}

/** Active and not past its expiry, without settling (and so persisting)
 *  anything. The scripted-run paths run on the gateway thread. */
function liveNow(gr: KeychainGrant): boolean {
  return (
    gr.status === "active" && Date.now() <= new Date(gr.expiresAt).getTime()
  );
}

export interface RunClaim {
  grant: KeychainGrant;
  credential: KeychainCredentialMeta;
}

/**
 * Claim this session's approved run grants to start one run of `command`
 * with these credentials. The command must be the one the owners approved,
 * character for character. With one credential, that credential's ungrouped
 * run grant; with several, one grant per credential, all from the same
 * request, so the run starts only once every owner approved. The grants
 * then live until the run's deadline and cannot start a second run. The
 * claim is made in memory before the store is written, so two concurrent
 * starts cannot both take a grant; if the write fails, the claim is undone.
 * Never blocks on the filesystem.
 */
export async function claimRunGrants(input: {
  sessionId: string;
  credentials: string[];
  command: string;
  runId: string;
  deadline: number;
}): Promise<{ claims: RunClaim[] } | { error: string }> {
  await ensureKeychainLoaded();
  const metas: KeychainCredentialMeta[] = [];
  for (const ref of input.credentials) {
    const credMeta = findCredential(ref);
    if (!credMeta) return { error: `no credential matches "${ref}"` };
    if (metas.some((m) => m.id === credMeta.id))
      return { error: `${credMeta.service} is listed twice` };
    metas.push(credMeta);
  }
  if (!metas.length) return { error: "name at least one credential" };
  const unclaimed = (credMeta: KeychainCredentialMeta) =>
    [...grants.values()]
      .filter(
        (gr) =>
          gr.sessionId === input.sessionId &&
          gr.credentialId === credMeta.id &&
          gr.mode === "run" &&
          liveNow(gr) &&
          !gr.runId &&
          !!gr.run?.group === metas.length > 1,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  let chosen: KeychainGrant[];
  if (metas.length === 1) {
    const credMeta = metas[0]!;
    const runGrants = unclaimed(credMeta);
    if (!runGrants.length)
      return {
        error: `this session holds no approved scripted run for ${credMeta.service}. Ask its owner with request_credential({ credential, purpose, run: { command, maxCalls } }) first`,
      };
    const gr = runGrants.find((g) => g.run?.command === input.command);
    if (!gr)
      return {
        error: `the owner approved a different command (${runGrants.map((g) => JSON.stringify(g.run?.command)).join(", ")}). Run exactly that, or ask again for this one`,
      };
    chosen = [gr];
  } else {
    const found = findRunGroup(
      input.sessionId,
      metas,
      input.command,
      unclaimed,
    );
    if ("error" in found) return found;
    chosen = found.grants;
  }

  const before = chosen.map((gr) => gr.expiresAt);
  for (const gr of chosen) {
    gr.runId = input.runId;
    gr.expiresAt = new Date(input.deadline).toISOString();
    grants.set(gr.id, gr);
  }
  try {
    await persistAsync();
  } catch (error) {
    chosen.forEach((gr, i) => {
      if (gr.runId !== input.runId) return;
      delete gr.runId;
      gr.expiresAt = before[i]!;
    });
    console.error("[keychain] failed to save a run claim:", error);
    return { error: "couldn't write the keychain store" };
  }
  for (const gr of chosen)
    auditAsync({
      kind: "keychain_run_started",
      grant_id: gr.id,
      run_id: input.runId,
      credential_id: gr.credentialId,
      session_id: gr.sessionId,
      owner: gr.owner,
      max_calls: gr.run?.maxCalls,
      ...(gr.run?.group ? { run_group: gr.run.group.id } : {}),
    });
  return {
    claims: chosen.map((grant, i) => ({ grant, credential: metas[i]! })),
  };
}

const sameServices = (members: KeychainRunMember[], services: string[]) =>
  members.length === services.length &&
  members.every((m) => services.includes(m.service));

/** One live, unclaimed grant per credential, all from one multi-credential
 *  request for this command, in the order of `metas`. */
function findRunGroup(
  sessionId: string,
  metas: KeychainCredentialMeta[],
  command: string,
  unclaimed: (credMeta: KeychainCredentialMeta) => KeychainGrant[],
): { grants: KeychainGrant[] } | { error: string } {
  const services = metas.map((m) => m.service);
  const candidates = metas.map((m) =>
    unclaimed(m).filter(
      (gr) =>
        gr.run?.command === command &&
        sameServices(gr.run.group!.members, services),
    ),
  );
  for (const first of candidates[0]!) {
    const groupId = first.run!.group!.id;
    const set = candidates.map((list) =>
      list.find((gr) => gr.run!.group!.id === groupId),
    );
    if (set.every(Boolean)) return { grants: set as KeychainGrant[] };
  }
  // Name what is missing: the approvals still out, or that none was asked.
  const missing = metas.filter((_, i) => !candidates[i]!.length);
  const waiting = [...keychainAsks.values()].filter(
    (a) =>
      a.status === "pending" &&
      a.sessionId === sessionId &&
      a.run?.command === command &&
      !!a.run.group &&
      sameServices(a.run.group.members, services),
  );
  if (waiting.length)
    return {
      error: `the run starts only once every credential's owner approved. Still waiting on ${waiting
        .map((a) => `${a.owner} (${findCredential(a.credentialId)?.service})`)
        .join(", ")}`,
    };
  return {
    error: `this session holds no approved scripted run of that command with ${services.join(" and ")}${
      missing.length && missing.length < metas.length
        ? ` (none for ${missing.map((m) => m.service).join(", ")})`
        : ""
    }. Ask with request_credential({ credentials: [...], purpose, run: { command, maxCalls } }) first`,
  };
}

/**
 * Check one proxied call of a run against its grant: still active, claimed
 * by this run, and inside the credential's ceiling. Nothing is persisted,
 * so a run can make many calls without rewriting the store.
 */
export function useRunGrant(
  grantId: string,
  runId: string,
  method: string,
  path: string,
): { credential: KeychainCredential } | { error: string; status: number } {
  load();
  const gr = grants.get(grantId);
  if (!gr || gr.mode !== "run" || gr.runId !== runId)
    return { error: "unknown run", status: 403 };
  // Checked, not settled: settling persists, and this runs per call on the
  // gateway thread. The run's own deadline timer ends it and settles the
  // grant asynchronously.
  if (!liveNow(gr))
    return {
      error: `the run's grant is ${gr.status === "active" ? "expired" : gr.status}`,
      status: 403,
    };
  const cred = credentials.get(gr.credentialId);
  if (!cred || cred.kind === "login")
    return { error: "credential no longer exists", status: 403 };
  const refusal = ceilingRefusal(cred, method, path);
  return refusal ? { error: refusal, status: 403 } : { credential: cred };
}

export interface LoginRelease {
  credential: KeychainCredential;
  grant: KeychainGrant;
  /** Puts the grant back if the password never reached the workspace. */
  undo: () => Promise<void>;
}

/**
 * Spend this session's approved release grant for a login. The grant is
 * marked used in memory before the store is written, so two concurrent
 * releases cannot both take it. The caller writes the password where the
 * session can read it and calls `undo` if that fails, so a write error does
 * not cost the owner another approval. Never blocks on the filesystem.
 */
export async function claimLoginRelease(input: {
  sessionId: string;
  credential: string;
}): Promise<LoginRelease | { error: string }> {
  await ensureKeychainLoaded();
  const credMeta = findCredential(input.credential);
  if (!credMeta)
    return { error: `no credential matches "${input.credential}"` };
  if (credMeta.kind !== "login")
    return {
      error: `${credMeta.service} is an API credential, so its secret is never released. Use call_credential`,
    };
  const gr = [...grants.values()]
    .filter(
      (g) =>
        g.sessionId === input.sessionId &&
        g.credentialId === credMeta.id &&
        g.mode === "release" &&
        liveNow(g),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!gr)
    return {
      error: `this session holds no approved release for ${credMeta.service}. Ask its owner with request_credential({ credential: "${credMeta.service}", purpose }) first`,
    };
  const cred = credentials.get(gr.credentialId)!;
  gr.status = "used";
  gr.usedAt = new Date().toISOString();
  grants.set(gr.id, gr);
  const undo = async () => {
    if (gr.status !== "used") return;
    gr.status = "active";
    delete gr.usedAt;
    grants.set(gr.id, gr);
    await persistAsync().catch(() => {});
  };
  try {
    await persistAsync();
  } catch (error) {
    await undo();
    console.error("[keychain] failed to save a login release:", error);
    return { error: "couldn't write the keychain store" };
  }
  auditAsync({
    kind: "keychain_login_released",
    grant_id: gr.id,
    credential_id: gr.credentialId,
    session_id: gr.sessionId,
    owner: gr.owner,
    requested_by: gr.requestedBy,
  });
  return { credential: cred, grant: gr, undo };
}

/** Close a run's grants when the run ends, without blocking on the store. */
export async function settleRunGrants(
  runId: string,
  calls: Array<{ grantId: string; calls: number }>,
): Promise<void> {
  let changed = false;
  for (const { grantId, calls: made } of calls) {
    const gr = grants.get(grantId);
    if (!gr || gr.runId !== runId) continue;
    gr.runCalls = made;
    if (gr.status === "active") {
      gr.status = "used";
      gr.usedAt = new Date().toISOString();
    }
    grants.set(gr.id, gr);
    changed = true;
  }
  if (changed) await persistAsync();
}

/** Save how many calls a live run made with each grant, so a server restart
 *  that cuts it off leaves a record of how far it got. */
export async function saveRunProgress(
  runId: string,
  calls: Array<{ grantId: string; calls: number }>,
): Promise<void> {
  let changed = false;
  for (const { grantId, calls: made } of calls) {
    const gr = grants.get(grantId);
    if (!gr || gr.runId !== runId || gr.runCalls === made) continue;
    gr.runCalls = made;
    changed = true;
  }
  if (changed) await persistAsync();
}

/**
 * The grant this session would use for a credential: its live standing grant
 * if it has one (so a once grant is not spent by accident), else its newest
 * live once grant.
 */
export function activeGrantFor(
  sessionId: string,
  credentialRef: string,
): KeychainGrant | undefined {
  const cred = findCredential(credentialRef);
  if (!cred) return undefined;
  const live = listGrants({ sessionId }).filter(
    (gr) =>
      gr.credentialId === cred.id &&
      gr.status === "active" &&
      gr.mode !== "run" &&
      gr.mode !== "release",
  );
  return live.find((gr) => gr.mode === "standing") ?? live[0];
}

export function brokerHeaders(
  cred: KeychainCredential,
): Record<string, string> {
  const header = cred.injection?.header || "Authorization";
  const scheme =
    cred.injection?.scheme ?? (header === "Authorization" ? "Bearer" : "");
  return { [header]: scheme ? `${scheme} ${cred.secret}` : cred.secret };
}

/** Scrub the secret from a text body the remote echoed back: verbatim, and
 *  in its common encodings. Best effort; statusOnly is the guarantee. */
export function scrubSecret(body: string, secret: string): string {
  if (!secret) return body;
  const forms = new Set([
    secret,
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
  ]);
  let out = body;
  for (const form of forms)
    if (form.length >= 4 && out.includes(form))
      out = out.split(form).join("[redacted]");
  return out;
}

// ── Asks (through the human-asks transport) ─────────────────────────────────

const APPROVE_ONCE = "Approve once";
const APPROVE_STANDING = "Approve standing";
const APPROVE_RUN = "Approve run";
const RELEASE_PASSWORD = "Release password";
const DECLINE = "Decline";

const KEYCHAIN_ASK_DOMAIN = "keychain-ask";

/** The steer/tool text a session gets when its ask is approved. This is the
 *  agent's entire manual for the grant, so it names every constraint. */
export function grantInstructions(
  gr: KeychainGrant,
  credMeta: KeychainCredentialMeta,
): string {
  const limits = [
    credMeta.allowedMethods?.length
      ? `methods: ${credMeta.allowedMethods.join(", ")}`
      : null,
    credMeta.allowedPathPrefixes?.length
      ? `paths: ${credMeta.allowedPathPrefixes.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  if (gr.mode === "release")
    return (
      `${gr.owner} approved releasing the **${credMeta.service}** login to this session ` +
      `(once, grant ${gr.id}; use it before ${gr.expiresAt}).\n` +
      `Call use_login({ credential: "${credMeta.service}" }). It writes the password to a file in this ` +
      `session's workspace and returns the sign-in page, the username and the file's path. ` +
      `Type the password into the page from that file in a script (for example with Playwright's fill or ` +
      `CDP Input.insertText). Never print it, never put it in a message, a commit, a screenshot or a log, ` +
      `and never save it anywhere else. The file is deleted after a short while; ask again if you need it later. ` +
      `Stay within the approved purpose ("${gr.purpose}"); the release is audited.`
    );
  if (gr.mode === "run" && gr.run?.group)
    return runGroupAnswer(gr.sessionId, gr.run.group.id);
  if (gr.mode === "run" && gr.run)
    return (
      `${gr.owner} approved a scripted run with **${credMeta.service}** ` +
      `(up to ${gr.run.maxCalls} calls, grant ${gr.id}; start it before ${gr.expiresAt}).\n` +
      `Start it with run_with_credential({ credential: "${credMeta.service}", command: ${JSON.stringify(gr.run.command)} }), ` +
      `optionally with cwd and timeoutMinutes. The command must be exactly that. ` +
      `The script gets KEYCHAIN_PROXY_URL (also as ${proxyEnvName(credMeta.service)}): use it as the API base URL in place of https://${credMeta.host}; ` +
      `the proxy injects the credential and stops working when the script exits. ` +
      `Poll credential_run_status for progress and output. ` +
      (limits ? `Limits: ${limits}. ` : "") +
      `Stay within the approved purpose ("${gr.purpose}"); every proxied call is audited.`
    );
  return (
    `${gr.owner} approved your keychain ask for **${credMeta.service}** ` +
    `(${gr.mode === "once" ? "one single call" : `standing until ${gr.expiresAt}`}, grant ${gr.id}).\n` +
    `Call the API with the call_credential tool: ` +
    `call_credential({ credential: "${credMeta.service}", method, path }), where path is the path and query on https://${credMeta.host}. ` +
    `The credential is injected server-side; you never see the secret, and the grant works only in this session. ` +
    (limits ? `Limits: ${limits}. ` : "") +
    (credMeta.statusOnly
      ? "This credential returns only the HTTP status, never the response body. "
      : "") +
    (gr.mode === "once"
      ? "The grant is SINGLE-USE: the first call consumes it, so make it the right one. "
      : "") +
    `Stay within the approved purpose ("${gr.purpose}"); every call is audited.`
  );
}

export interface RequestCredentialInput {
  /** Credential id or service slug. */
  credential: string;
  sessionId: string;
  requestedBy: string;
  purpose: string;
  mode?: Exclude<GrantMode, "run">;
  /** Ask for a scripted run instead of once/standing calls. */
  run?: KeychainScriptedRun;
}

export type RequestCredentialResult =
  /** A new ask, or (resurfaced) this session's ask already awaiting the owner. */
  | { ask: KeychainAskRecord; transport: HumanAsk; resurfaced?: true }
  /** This session already holds a live grant that covers the request. */
  | { grant: KeychainGrant; instructions: string }
  | { error: string };

export function requestCredential(
  input: RequestCredentialInput,
): RequestCredentialResult {
  load();
  const credMeta = findCredential(input.credential);
  if (!credMeta) {
    const known = listCredentials()
      .map((c) => c.service)
      .join(", ");
    return {
      error: `no credential matches "${input.credential}"${known ? ` (known: ${known})` : ""}`,
    };
  }
  const purpose = input.purpose.trim();
  if (!purpose)
    return {
      error: "a purpose is required — the owner approves that, not the tool",
    };
  const owner = resolveTeammate(credMeta.owner);
  if (!owner)
    return {
      error: `credential owner "${credMeta.owner}" is not in the identity roster`,
    };

  const isLogin = credMeta.kind === "login";
  if (isLogin && input.run)
    return {
      error: `${credMeta.service} is a login: it can't be used by a scripted run. Ask without \`run\` to have the password released to this session`,
    };
  let run: KeychainScriptedRun | undefined;
  if (input.run) {
    const command = runCommand(input.run.command);
    if ("error" in command) return command;
    const capError = maxCallsError(input.run.maxCalls);
    if (capError) return { error: capError };
    run = { command: command.command, maxCalls: input.run.maxCalls };
  }
  const requestedMode: GrantMode = isLogin
    ? "release"
    : run
      ? "run"
      : input.mode || "once";
  const sameRun = (other?: KeychainScriptedRun) =>
    (!run && !other) ||
    (!!run &&
      !!other &&
      !other.group &&
      run.command === other.command &&
      run.maxCalls === other.maxCalls);
  // An approval that landed after the caller stopped waiting is already a
  // grant: hand it back rather than asking the owner twice. Only for the
  // purpose (and script) the owner approved; anything new is a new ask.
  const live = listGrants({ sessionId: input.sessionId }).find(
    (gr) =>
      gr.credentialId === credMeta.id &&
      gr.status === "active" &&
      !gr.runId &&
      norm(gr.purpose) === norm(purpose) &&
      sameRun(gr.run) &&
      (gr.mode === requestedMode ||
        (gr.mode === "standing" && requestedMode === "once")),
  );
  if (live)
    return { grant: live, instructions: grantInstructions(live, credMeta) };

  const pending = [...keychainAsks.values()].find(
    (a) =>
      a.status === "pending" &&
      a.credentialId === credMeta.id &&
      a.sessionId === input.sessionId,
  );
  if (pending) {
    const transport = pending.humanAskId
      ? getAsk(pending.humanAskId)
      : undefined;
    // Still in front of the owner: re-surface it instead of refusing, so a
    // caller that gave up waiting can pick the same ask back up.
    if (
      transport &&
      transport.state !== "answered" &&
      transport.state !== "cancelled"
    ) {
      // The owner is approving that ask's sentence, not this one.
      if (norm(pending.purpose) !== norm(purpose) || !sameRun(pending.run))
        return {
          error:
            `a different ask for this credential is already pending (${pending.id}, purpose: "${pending.purpose}"). ` +
            `Ask again with that purpose to remind the owner, or withdraw it with cancel_credential_ask first`,
        };
      return { ask: pending, transport, resurfaced: true };
    }
    // Its owner message is gone (cancelled or settled without reaching this
    // record), so nobody can answer it. Close it and ask afresh.
    settleAsk(pending, "cancelled", "owner message no longer open");
  }

  const record: KeychainAskRecord = {
    id: `ka-${crypto.randomUUID()}`,
    credentialId: credMeta.id,
    owner: credMeta.owner,
    sessionId: input.sessionId,
    requestedBy: input.requestedBy,
    purpose,
    requestedMode,
    ...(run ? { run } : {}),
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const transport = registerAsk({
    sessionId: input.sessionId,
    createdBy: input.requestedBy,
    person: { slackId: owner.slackId, name: owner.name },
    question: isLogin
      ? `May this session have the password for your **${credMeta.service}** login ` +
        `(${credMeta.username} on ${credMeta.loginUrl})?\nPurpose: ${purpose}\n` +
        `The agent will see the password: it types it into the sign-in page itself. ` +
        `Approve only for a test account.`
      : run
        ? `May this session run a script with your **${credMeta.service}** credential ` +
          `(${credMeta.host})? This is a scripted run: bulk API use, not a single call.\n` +
          `Purpose: ${purpose}\nCommand: \`${run.command}\`\n` +
          `Expected volume: up to ${run.maxCalls.toLocaleString("en-US")} API calls, refused beyond that.` +
          interruptedNote(input.sessionId, run.command, [credMeta.id])
        : `May this session borrow your **${credMeta.service}** credential ` +
          `(${credMeta.host})?\nPurpose: ${purpose}\nRequested: ${record.requestedMode} ` +
          `(once = a single API call through the broker; standing = 7 days, revocable).`,
    context: isLogin
      ? "_Releasing writes the password to a short-lived file in that session's workspace, " +
        "once. It never appears in the transcript, but the agent can read it, so treat it as " +
        "disclosed to that session. The release is audited._"
      : run
        ? "_The script never sees the secret. It gets a proxy URL that works only for " +
          "this one process, within the credential's method/path limits, and stops " +
          "working when the script exits or times out. Every call is audited, and " +
          "revoking the grant stops the run._"
        : "_The secret is never shown to the session — approved calls go through the " +
          "keychain broker with method/path limits, and every call is audited._",
    options: isLogin
      ? [RELEASE_PASSWORD, DECLINE]
      : run
        ? [APPROVE_RUN, DECLINE]
        : [APPROVE_ONCE, APPROVE_STANDING, DECLINE],
    mode: "block",
    deliver: "now",
    domain: { kind: KEYCHAIN_ASK_DOMAIN, ref: record.id },
    // The requester may be driving the very session a card would appear in.
    personOnly: true,
  });

  record.humanAskId = transport.id;
  keychainAsks.set(record.id, record);
  persist();
  audit({
    kind: "keychain_ask_created",
    ask_id: record.id,
    credential_id: credMeta.id,
    session_id: input.sessionId,
    requested_by: input.requestedBy,
    mode: record.requestedMode,
    owner: credMeta.owner,
    ...(run ? { max_calls: run.maxCalls } : {}),
  });
  return { ask: record, transport };
}

function runCommand(raw: string): { command: string } | { error: string } {
  const command = raw.trim();
  if (!command || command.length > MAX_RUN_COMMAND_CHARS)
    return {
      error: `a scripted run needs a command of at most ${MAX_RUN_COMMAND_CHARS} characters`,
    };
  return { command };
}

function maxCallsError(maxCalls: number): string | null {
  return Number.isInteger(maxCalls) &&
    maxCalls >= 1 &&
    maxCalls <= MAX_RUN_CALLS
    ? null
    : `maxCalls must be a whole number from 1 to ${MAX_RUN_CALLS}`;
}

/** For an owner asked to approve a command again: an earlier approved run
 *  of it in this session was cut off by a server restart. */
function interruptedNote(
  sessionId: string,
  command: string,
  credentialIds: string[],
): string {
  const cut = [...grants.values()]
    .filter(
      (gr) =>
        gr.sessionId === sessionId &&
        gr.mode === "run" &&
        gr.interrupted &&
        gr.run?.command === command &&
        credentialIds.includes(gr.credentialId),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!cut.length) return "";
  const made = cut
    .filter((gr) => gr.runCalls !== undefined)
    .map(
      (gr) =>
        `${gr.runCalls!.toLocaleString("en-US")} calls with ${credentials.get(gr.credentialId)?.service ?? gr.credentialId}`,
    );
  return (
    `\nResume: you approved this command for this session on ${cut[0]!.createdAt.slice(0, 10)}, ` +
    `and a server restart cut that run off` +
    (made.length ? ` after about ${made.join(" and ")}` : "") +
    `. Approving starts it again from the beginning of the command.`
  );
}

export interface RequestCredentialRunInput {
  /** Credential ids or service slugs, at least two. */
  credentials: string[];
  sessionId: string;
  requestedBy: string;
  purpose: string;
  /** maxCalls is per credential: one number for each, or one per slug. */
  run: { command: string; maxCalls: number | Record<string, number> };
}

export type RequestCredentialRunResult =
  /** New asks, or (resurfaced) this request's asks still awaiting owners:
   *  one owner message for each owner. */
  | { asks: KeychainAskRecord[]; transports: HumanAsk[]; resurfaced?: true }
  /** Every owner already approved this run. */
  | { grants: KeychainGrant[]; instructions: string }
  | { error: string };

/**
 * Ask for one scripted run that uses several credentials. Each credential's
 * owner approves their part: one message per owner, listing every
 * credential in the run, the command and each cap. The asks and grants
 * share a group id, and run_with_credential starts the run only once a live
 * grant exists for every credential in the group.
 */
export function requestCredentialRun(
  input: RequestCredentialRunInput,
): RequestCredentialRunResult {
  load();
  if (
    input.credentials.length < 2 ||
    input.credentials.length > MAX_RUN_CREDENTIALS
  )
    return {
      error: `a run with several credentials names 2 to ${MAX_RUN_CREDENTIALS} of them`,
    };
  const metas: KeychainCredentialMeta[] = [];
  for (const ref of input.credentials) {
    const credMeta = findCredential(ref);
    if (!credMeta) return { error: `no credential matches "${ref}"` };
    if (metas.some((m) => m.id === credMeta.id))
      return { error: `${credMeta.service} is listed twice` };
    if (credMeta.kind === "login")
      return {
        error: `${credMeta.service} is a login: it can't be used by a scripted run`,
      };
    if (!resolveTeammate(credMeta.owner))
      return {
        error: `credential owner "${credMeta.owner}" is not in the identity roster`,
      };
    metas.push(credMeta);
  }
  const envNames = metas.map((m) => proxyEnvName(m.service));
  const clash = envNames.find((n, i) => envNames.indexOf(n) !== i);
  if (clash)
    return {
      error: `two of these credentials would share the variable ${clash}; run them separately`,
    };
  const purpose = input.purpose.trim();
  if (!purpose)
    return {
      error: "a purpose is required — the owner approves that, not the tool",
    };
  const command = runCommand(input.run.command);
  if ("error" in command) return command;
  const caps = input.run.maxCalls;
  if (typeof caps === "object") {
    const extra = Object.keys(caps).filter(
      (k) => !metas.some((m) => m.service === norm(k)),
    );
    if (extra.length)
      return {
        error: `maxCalls names ${extra.join(", ")}, which is not in this run`,
      };
  }
  const members: KeychainRunMember[] = [];
  for (const m of metas) {
    const maxCalls =
      typeof caps === "number"
        ? caps
        : Object.entries(caps).find(([k]) => norm(k) === m.service)?.[1];
    if (maxCalls === undefined)
      return { error: `maxCalls has no cap for ${m.service}` };
    const capError = maxCallsError(maxCalls);
    if (capError) return { error: `${m.service}: ${capError}` };
    members.push({
      service: m.service,
      host: m.host,
      owner: m.owner,
      maxCalls,
    });
  }
  const sameRequest = (r: KeychainScriptedRun | undefined, p: string) =>
    !!r?.group &&
    r.command === command.command &&
    norm(p) === norm(purpose) &&
    r.group.members.length === members.length &&
    members.every((m) =>
      r.group!.members.some(
        (o) => o.service === m.service && o.maxCalls === m.maxCalls,
      ),
    );
  const ids = new Set(metas.map((m) => m.id));

  // Every owner already approved: hand the grants back.
  const live = listGrants({ sessionId: input.sessionId }).filter(
    (gr) =>
      ids.has(gr.credentialId) &&
      gr.status === "active" &&
      !gr.runId &&
      sameRequest(gr.run, gr.purpose),
  );
  for (const gr of live) {
    const set = metas.map((m) =>
      live.find(
        (o) =>
          o.credentialId === m.id && o.run!.group!.id === gr.run!.group!.id,
      ),
    );
    if (set.every(Boolean))
      return {
        grants: set as KeychainGrant[],
        instructions: runGroupAnswer(input.sessionId, gr.run!.group!.id),
      };
  }

  const pending = [...keychainAsks.values()].filter(
    (a) =>
      a.status === "pending" &&
      a.sessionId === input.sessionId &&
      ids.has(a.credentialId),
  );
  if (pending.length) {
    const open = (a: KeychainAskRecord) => {
      const t = a.humanAskId ? getAsk(a.humanAskId) : undefined;
      return t && t.state !== "answered" && t.state !== "cancelled"
        ? t
        : undefined;
    };
    const ours = pending.filter((a) => sameRequest(a.run, a.purpose));
    const other = pending.find(
      (a) => !sameRequest(a.run, a.purpose) && open(a),
    );
    if (other)
      return {
        error:
          `a different ask for ${findCredential(other.credentialId)?.service} is already pending (${other.id}, purpose: "${other.purpose}"). ` +
          `Ask again with that purpose to remind the owner, or withdraw it with cancel_credential_ask first`,
      };
    const groupId = ours[0]?.run?.group?.id;
    const group = ours.filter((a) => a.run?.group?.id === groupId);
    // Resurface only a request that can still complete: every credential
    // either still waits on its owner or holds a live approval from it. An
    // approval that expired or was revoked can't be given again on that
    // request, so it needs a fresh one.
    const completable = metas.every(
      (m) =>
        group.some((a) => a.credentialId === m.id) ||
        [...grants.values()].some(
          (gr) =>
            gr.sessionId === input.sessionId &&
            gr.credentialId === m.id &&
            gr.run?.group?.id === groupId &&
            !gr.runId &&
            liveNow(gr),
        ),
    );
    if (group.length && completable && group.every(open)) {
      const transports = [
        ...new Map(group.map((a) => [a.humanAskId!, open(a)!])).values(),
      ];
      return { asks: group, transports, resurfaced: true };
    }
    // An owner message or an approval is gone, so that request can never be
    // complete.
    for (const a of pending) {
      settleAsk(a, "cancelled", "the run's request can no longer complete");
      if (a.humanAskId) cancelAsk(a.humanAskId);
    }
  }

  const group: KeychainRunGroup = { id: `krg-${crypto.randomUUID()}`, members };
  const records: KeychainAskRecord[] = [];
  const transports: HumanAsk[] = [];
  const owners: string[] = [];
  for (const m of metas)
    if (!owners.some((o) => sameOwner(o, m.owner))) owners.push(m.owner);
  const now = new Date().toISOString();
  const runList = members
    .map(
      (m) =>
        `• **${m.service}** (${m.host}, owner ${m.owner}): up to ${m.maxCalls.toLocaleString("en-US")} calls`,
    )
    .join("\n");
  for (const owner of owners) {
    const person = resolveTeammate(owner)!;
    const mine = metas.filter((m) => sameOwner(m.owner, owner));
    const others = metas.filter((m) => !sameOwner(m.owner, owner));
    const ownerRecords = mine.map((m): KeychainAskRecord => ({
      id: `ka-${crypto.randomUUID()}`,
      credentialId: m.id,
      owner: m.owner,
      sessionId: input.sessionId,
      requestedBy: input.requestedBy,
      purpose,
      requestedMode: "run",
      run: {
        command: command.command,
        maxCalls: members.find((x) => x.service === m.service)!.maxCalls,
        group,
      },
      status: "pending",
      createdAt: now,
    }));
    const transport = registerAsk({
      sessionId: input.sessionId,
      createdBy: input.requestedBy,
      person: { slackId: person.slackId, name: person.name },
      question:
        `May this session run one script with ${members.length} credentials, ` +
        `including your ${mine.map((m) => `**${m.service}**`).join(" and ")}? ` +
        `This is a scripted run: bulk API use, not a single call.\n` +
        `Purpose: ${purpose}\nCommand: \`${command.command}\`\n` +
        `Credentials in this run, each refused beyond its cap:\n${runList}` +
        (others.length
          ? `\nThe run starts only once ${[...new Set(others.map((m) => m.owner))].join(" and ")} also approve${others.length === 1 ? "s" : ""}.`
          : "") +
        interruptedNote(input.sessionId, command.command, [...ids]),
      context:
        "_The script never sees a secret. It gets one proxy URL per credential, each " +
        "reaching only that credential's host within its method/path limits, and all " +
        "of them stop working when the script exits or times out. Every call is " +
        "audited, and revoking your grant stops the whole run._",
      options: [APPROVE_RUN, DECLINE],
      mode: "block",
      deliver: "now",
      domain: { kind: KEYCHAIN_ASK_DOMAIN, ref: ownerRecords[0]!.id },
      personOnly: true,
    });
    for (const record of ownerRecords) {
      record.humanAskId = transport.id;
      keychainAsks.set(record.id, record);
      records.push(record);
      audit({
        kind: "keychain_ask_created",
        ask_id: record.id,
        credential_id: record.credentialId,
        session_id: input.sessionId,
        requested_by: input.requestedBy,
        mode: "run",
        owner: record.owner,
        max_calls: record.run!.maxCalls,
        run_group: group.id,
      });
    }
    transports.push(transport);
  }
  persist();
  return { asks: records, transports };
}

/**
 * Where a multi-credential run's approvals stand, as the text the
 * requesting session gets: declined, still waiting on some owners, or the
 * instructions to start it.
 */
export function runGroupAnswer(sessionId: string, groupId: string): string {
  load();
  const asks = [...keychainAsks.values()].filter(
    (a) => a.sessionId === sessionId && a.run?.group?.id === groupId,
  );
  const groupGrants = [...grants.values()].filter(
    (gr) => gr.sessionId === sessionId && gr.run?.group?.id === groupId,
  );
  const group = (asks[0]?.run ?? groupGrants[0]?.run)?.group;
  if (!group) return "That scripted run is no longer on record.";
  const services = group.members.map((m) => m.service);
  const declined = asks.filter((a) => a.status === "declined");
  if (declined.length)
    return (
      `${[...new Set(declined.map((a) => a.owner))].join(" and ")} declined the scripted run with ${services.join(", ")}` +
      (declined[0]!.note ? ` — "${declined[0]!.note}"` : "") +
      ". The run can't start, and the other owners' asks were withdrawn. Don't retry the same ask; " +
      "either work without it, or tell the user why you need it and let them take it up with the owner."
    );
  const approved = groupGrants.filter(liveNow);
  const has = (service: string) =>
    approved.some(
      (gr) => credentials.get(gr.credentialId)?.service === service,
    );
  const missing = group.members.filter((m) => !has(m.service));
  if (missing.length) {
    const ok = group.members.filter((m) => has(m.service));
    const asked = (m: KeychainRunMember) =>
      asks.some(
        (a) =>
          a.status === "pending" &&
          credentials.get(a.credentialId)?.service === m.service,
      );
    const waiting = missing.filter(asked);
    const lapsed = missing.filter((m) => !asked(m));
    return (
      (ok.length
        ? `${ok.map((m) => `${m.owner} approved ${m.service}`).join("; ")}. `
        : "") +
      `The run starts only once every owner approved: ` +
      (waiting.length
        ? `still waiting on ${waiting.map((m) => `${m.owner} for ${m.service}`).join(", ")}; their answer arrives in this session as a message. `
        : "") +
      (lapsed.length
        ? `there is no live approval for ${lapsed.map((m) => m.service).join(", ")} (expired, revoked or withdrawn), so ask again with request_credential.`
        : "")
    ).trim();
  }
  const first = approved[0]!;
  const credsJson = JSON.stringify(services);
  const lines = group.members.map((m) => {
    const cred = credentials.get(
      approved.find(
        (gr) => credentials.get(gr.credentialId)?.service === m.service,
      )!.credentialId,
    )!;
    const limits = [
      cred.allowedMethods?.length
        ? `methods ${cred.allowedMethods.join(", ")}`
        : null,
      cred.allowedPathPrefixes?.length
        ? `paths ${cred.allowedPathPrefixes.join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("; ");
    return (
      `- ${proxyEnvName(m.service)}: in place of https://${m.host} (${m.service}, up to ${m.maxCalls} calls` +
      (limits ? `; ${limits}` : "") +
      ")"
    );
  });
  return (
    `Every owner approved a scripted run with ${services.map((s) => `**${s}**`).join(" and ")} ` +
    `(start it before ${approved.map((gr) => gr.expiresAt).sort()[0]}).\n` +
    `Start it with run_with_credential({ credentials: ${credsJson}, command: ${JSON.stringify(first.run!.command)} }), ` +
    `optionally with cwd and timeoutMinutes. The command must be exactly that. ` +
    `The script gets one proxy URL per credential, each reaching only that credential's host:\n${lines.join("\n")}\n` +
    `The proxies inject the credentials and stop working when the script exits. ` +
    `Poll credential_run_status for progress and output. ` +
    `Stay within the approved purpose ("${first.purpose}"); every proxied call is audited.`
  );
}

function settleAsk(
  record: KeychainAskRecord,
  status: "cancelled",
  note: string,
): void {
  record.status = status;
  record.resolvedAt = new Date().toISOString();
  record.note = note;
  keychainAsks.set(record.id, record);
  persist();
  audit({
    kind: "keychain_ask_cancelled",
    ask_id: record.id,
    credential_id: record.credentialId,
    session_id: record.sessionId,
    note,
  });
}

/** Withdraw a session's own pending ask; the owner is told it's moot. */
export function cancelCredentialAsk(
  askId: string,
  sessionId: string,
): { ask: KeychainAskRecord } | { error: string } {
  load();
  const record = keychainAsks.get(askId);
  if (!record || record.sessionId !== sessionId || record.status !== "pending")
    return { error: "no pending ask with that id in this session" };
  // A multi-credential run is asked for as a whole and withdrawn as one.
  const group = record.run?.group?.id;
  const withdrawn = group
    ? [...keychainAsks.values()].filter(
        (a) =>
          a.status === "pending" &&
          a.sessionId === sessionId &&
          a.run?.group?.id === group,
      )
    : [record];
  for (const a of withdrawn) {
    settleAsk(a, "cancelled", "withdrawn by the requesting session");
    if (a.humanAskId) cancelAsk(a.humanAskId);
  }
  return { ask: record };
}

export function listKeychainAsks(opts?: {
  sessionId?: string;
}): KeychainAskRecord[] {
  load();
  return [...keychainAsks.values()]
    .filter((a) => !opts?.sessionId || a.sessionId === opts.sessionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type OwnerDecision = "once" | "standing" | "run" | "release" | "decline";

/**
 * The owner answers an ask from Settings. `by` must be an identity the caller
 * has verified (a signed-in person, never a claimed name or an automation).
 * Goes through the same human-asks resolution as a Slack button, so the grant
 * is minted, the session is told, and the DM is marked answered exactly once.
 */
export function answerKeychainAsk(
  askId: string,
  decision: OwnerDecision,
  by: string,
): { ok: true; status: KeychainAskRecord["status"] } | { error: string } {
  load();
  const record = keychainAsks.get(askId);
  if (!record || record.status !== "pending" || !record.humanAskId)
    return { error: "That request is no longer waiting for an answer" };
  if (!by || !sameOwner(record.owner, by))
    return { error: "Only the credential's owner can answer this request" };
  // A scripted run is approved as a run or not at all, a login release as a
  // release or not at all, and neither approval fits any other ask.
  if (decision !== "decline") {
    const exclusive = (mode: "run" | "release") =>
      (decision === mode) !== (record.requestedMode === mode);
    if (exclusive("run"))
      return {
        error:
          record.requestedMode === "run"
            ? "This request is for a scripted run: approve the run or decline"
            : "This request is not for a scripted run",
      };
    if (exclusive("release"))
      return {
        error:
          record.requestedMode === "release"
            ? "This request is for a login: release the password or decline"
            : "This request is not for a login",
      };
  }
  const label =
    decision === "once"
      ? APPROVE_ONCE
      : decision === "standing"
        ? APPROVE_STANDING
        : decision === "run"
          ? APPROVE_RUN
          : decision === "release"
            ? RELEASE_PASSWORD
            : DECLINE;
  if (!resolveAskAsPerson(record.humanAskId, label, ownerName(by)))
    return { error: "That request is no longer waiting for an answer" };
  return { ok: true, status: keychainAsks.get(askId)?.status ?? "pending" };
}

/**
 * What one person may see of the keychain. Every credential's metadata, so a
 * teammate knows what exists to ask for. Grants and asks only where they are
 * the owner or the requester: a grant id is the broker's bearer token, so
 * listing everyone's would let any member replay any grant.
 */
export function keychainViewFor(user: string): {
  credentials: Array<KeychainCredentialMeta & { mine: boolean }>;
  grants: KeychainGrant[];
  asks: Array<KeychainAskRecord & { canAnswer: boolean }>;
} {
  load();
  const involved = (owner: string, requestedBy: string) =>
    !!user && (sameOwner(owner, user) || sameOwner(requestedBy, user));
  return {
    credentials: listCredentials().map((c) => ({
      ...c,
      mine: !!user && sameOwner(c.owner, user),
    })),
    grants: listGrants().filter((gr) => involved(gr.owner, gr.requestedBy)),
    asks: listKeychainAsks()
      .filter((a) => involved(a.owner, a.requestedBy))
      .map((a) => ({
        ...a,
        canAnswer: a.status === "pending" && sameOwner(a.owner, user),
      })),
  };
}

/** Parse the owner's answer (button label or free text). Fail closed: only an
 *  explicit approval approves; anything unrecognized declines with the text
 *  kept as the owner's note. */
export function parseOwnerAnswer(
  answer: string,
  requestedMode: GrantMode,
): { approve: true; mode: GrantMode } | { approve: false; note?: string } {
  const t = answer.trim().toLowerCase();
  // A run ask approves its run or nothing, a login ask its release or
  // nothing; a once/standing ask can never turn into either, whatever the
  // reply says.
  if (requestedMode === "run" || requestedMode === "release") {
    if (t === DECLINE.toLowerCase() || /^(no|deny|decline|reject)\b/.test(t))
      return { approve: false };
    const button = requestedMode === "run" ? APPROVE_RUN : RELEASE_PASSWORD;
    if (
      t === button.toLowerCase() ||
      /^(approve|release|yes|ok|sure|go ahead)\b/.test(t)
    )
      return { approve: true, mode: requestedMode };
    return { approve: false, note: answer.trim() };
  }
  if (t === APPROVE_ONCE.toLowerCase()) return { approve: true, mode: "once" };
  if (t === APPROVE_STANDING.toLowerCase())
    return { approve: true, mode: "standing" };
  if (/^(approve|yes|ok|sure|go ahead)\b/.test(t)) {
    return {
      approve: true,
      mode: /standing/.test(t) ? "standing" : requestedMode,
    };
  }
  if (t === DECLINE.toLowerCase() || /^(no|deny|decline|reject)\b/.test(t)) {
    return { approve: false };
  }
  return { approve: false, note: answer.trim() };
}

/**
 * The human-asks domain handler: runs inside resolveAsk when the owner
 * answers, whatever channel the answer came from (Slack button, free-text
 * DM reply, UI card). Mints or declines, and returns the steer text the
 * requesting session receives in place of the generic "X answered" line.
 */
function resolveKeychainAsk(ask: HumanAsk, answer: string): string | null {
  load();
  const ref = ask.domain?.ref;
  const record = ref ? keychainAsks.get(ref) : undefined;
  if (!record || record.status !== "pending") return null;
  // One owner message covers all of that owner's credentials in a
  // multi-credential run.
  const records = [
    record,
    ...[...keychainAsks.values()].filter(
      (a) => a !== record && a.status === "pending" && a.humanAskId === ask.id,
    ),
  ];

  const verdict = parseOwnerAnswer(answer, record.requestedMode);
  const resolvedAt = new Date().toISOString();

  if (!verdict.approve) {
    for (const r of records) {
      r.resolvedAt = resolvedAt;
      r.status = "declined";
      if (verdict.note) r.note = verdict.note;
      keychainAsks.set(r.id, r);
    }
    persist();
    for (const r of records)
      audit({
        kind: "keychain_ask_declined",
        ask_id: r.id,
        credential_id: r.credentialId,
        ...(r.note ? { note_len: r.note.length } : {}),
      });
    const group = record.run?.group;
    if (group) {
      // The run can't start now: the other owners need not answer.
      for (const other of keychainAsks.values())
        if (
          other.status === "pending" &&
          other.sessionId === record.sessionId &&
          other.run?.group?.id === group.id
        ) {
          settleAsk(other, "cancelled", `${record.owner} declined the run`);
          if (other.humanAskId) cancelAsk(other.humanAskId);
        }
      return runGroupAnswer(record.sessionId, group.id);
    }
    return (
      `${record.owner} declined the keychain ask for this credential` +
      (verdict.note ? ` — "${verdict.note}"` : "") +
      ". Don't retry the same ask; either work without it, or tell the user why you need it " +
      "and let them take it up with the owner."
    );
  }

  let grant: KeychainGrant | undefined;
  for (const r of records) {
    r.resolvedAt = resolvedAt;
    r.status = "approved";
    const minted = mintGrant(r, verdict.mode);
    grant ??= minted;
    r.grantId = minted.id;
    keychainAsks.set(r.id, r);
    audit({
      kind: "keychain_ask_approved",
      ask_id: r.id,
      grant_id: minted.id,
      mode: verdict.mode,
    });
  }
  const group = record.run?.group;
  if (group) startWindowOnceComplete(record.sessionId, group);
  persist();
  const credMeta = findCredential(record.credentialId);
  return credMeta && grant ? grantInstructions(grant, credMeta) : null;
}

/** When the last owner of a multi-credential run approves, the run may start
 *  within the ordinary start window from now. */
function startWindowOnceComplete(
  sessionId: string,
  group: KeychainRunGroup,
): void {
  const live = [...grants.values()].filter(
    (gr) =>
      gr.sessionId === sessionId &&
      gr.run?.group?.id === group.id &&
      !gr.runId &&
      liveNow(gr),
  );
  const covered = group.members.every((m) =>
    live.some((gr) => credentials.get(gr.credentialId)?.service === m.service),
  );
  if (!covered) return;
  const expiresAt = new Date(Date.now() + RUN_GRANT_START_TTL_MS).toISOString();
  for (const gr of live) gr.expiresAt = expiresAt;
}

/** Module-load side effect (re-runs on hot reload, overwriting the handler —
 *  that's the point: the newest code answers). Registered here, next to the
 *  handler, so importing the keychain anywhere wires the resolution path. */
registerAskDomainHandler(KEYCHAIN_ASK_DOMAIN, resolveKeychainAsk);
