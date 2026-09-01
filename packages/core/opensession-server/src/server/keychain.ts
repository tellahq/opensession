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
 *                Delivered to the owner through human-asks (Slack DM with
 *                Approve once / Approve standing / Decline buttons, UI-first
 *                card when the owner is driving a session). 24h TTL.
 *   grant      — the approval: scoped to the REQUESTING SESSION only,
 *                once (single broker call, 1h) or standing (7d), revocable,
 *                audited.
 *
 * Delivery is broker-only: the agent never sees the secret, it gets a grant
 * token and calls
 *
 *   http://127.0.0.1:<port>/api/keychain/broker/<grantId>/<path>
 *
 * (routes/keychain.ts) which injects the credential's header server-side and
 * proxies to the credential's host — constrained by the credential's
 * allowedMethods / allowedPathPrefixes, and with the secret scrubbed from any
 * text response that echoes it. A leaked grant token is scoped (one
 * credential, one session's purpose, method/path-limited, short-lived,
 * revocable, fully audited) where a leaked secret is forever — that
 * asymmetry is the whole design, same as qm's.
 *
 * Trust boundary: the opensession-keychain MCP server is interactive-only
 * (same bar as opensession-humans — never automation runs), so untrusted
 * ticket text cannot social-engineer an owner with a plausible "purpose".
 * Registration is HTTP-only (routes/keychain.ts, web-auth gated): a secret
 * typed into a session prompt would land in the transcript, so there is
 * deliberately no add_credential tool.
 *
 * Two limitations, stated rather than papered over:
 *
 *  1. The broker rides loopback, so grants work for runs on this box
 *     (worktrees, the shared checkout) but not inside remote sandboxes —
 *     those would need the dial-back channel, out of scope here.
 *  2. The grant id is a bearer token that lands in the requesting session's
 *     transcript, and transcripts are searchable across sessions
 *     (opensession-search). So a grant is scoped to a session by INTENT and
 *     by audit, not by cryptographic isolation: another session on this box
 *     that went looking could find and replay it inside its TTL. What bounds
 *     the damage is everything else — the credential's method/path ceiling,
 *     once-grants dying on first use, short TTLs, revocation, and an audit
 *     line per call recording the session a grant was issued to (so a replay
 *     from elsewhere is visible after the fact). Binding the broker to the
 *     calling run would need per-run identity on the loopback call, which the
 *     agent's shell does not have today.
 */

import { stateDir } from "./paths";
import { existsSync, readFileSync, chmodSync } from "node:fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { audit } from "./audit";
import { resolveTeammate } from "./shared/user-mappings";
import {
  registerAsk,
  registerAskDomainHandler,
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
const STANDING_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Terminal asks/grants older than this are pruned on load. */
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type GrantMode = "once" | "standing";

export interface KeychainCredential {
  id: string;
  /** Owner's roster first name — the person who approves asks for it. */
  owner: string;
  /** Lookup + display key, e.g. "vercel", "ahrefs". Unique per keychain. */
  service: string;
  description?: string;
  /** Broker target host (https assumed), e.g. "api.vercel.com". */
  host: string;
  /** How the secret rides the proxied request. Default Authorization: Bearer. */
  injection?: { header?: string; scheme?: string };
  /** Empty/undefined = all methods. */
  allowedMethods?: string[];
  /** Empty/undefined = all paths. */
  allowedPathPrefixes?: string[];
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
}

export interface KeychainAskRecord {
  id: string;
  credentialId: string;
  owner: string;
  sessionId: string;
  requestedBy: string;
  purpose: string;
  requestedMode: GrantMode;
  status: "pending" | "approved" | "declined" | "expired";
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

function persist(): void {
  const path = storePath();
  writeJsonAtomic(path, {
    credentials: [...credentials.values()],
    grants: [...grants.values()],
    asks: [...keychainAsks.values()],
  } satisfies Stored);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort — the file holds secrets, but a chmod failure must not
    // lose the write (the box is single-tenant either way)
  }
}

function load(): void {
  const path = storePath();
  if (loadedFrom === path) return;
  loadedFrom = path;
  if (!existsSync(path)) return;
  try {
    const data: Stored = JSON.parse(readFileSync(path, "utf-8"));
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    for (const c of data.credentials || []) credentials.set(c.id, c);
    for (const gr of data.grants || []) {
      if (gr.status !== "active" && new Date(gr.createdAt).getTime() < cutoff)
        continue;
      grants.set(gr.id, gr);
    }
    for (const a of data.asks || []) {
      if (a.status !== "pending" && new Date(a.createdAt).getTime() < cutoff)
        continue;
      keychainAsks.set(a.id, a);
    }
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
  host: string;
  secret: string;
  description?: string;
  injection?: { header?: string; scheme?: string };
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
}

export function addCredential(
  input: AddCredentialInput,
): KeychainCredentialMeta {
  load();
  const service = norm(input.service);
  const host = input.host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");
  if (!service || !/^[a-z0-9][a-z0-9._-]*$/.test(service)) {
    throw new Error(
      "service must be a short lowercase slug (letters, digits, . _ -)",
    );
  }
  if (!host || !/^[a-z0-9][a-z0-9.-]*$/.test(host) || host.includes(":")) {
    throw new Error("host must be a bare host name (no scheme, port, or path)");
  }
  if (!input.secret.trim()) throw new Error("secret is empty");
  if ([...credentials.values()].some((c) => c.service === service)) {
    throw new Error(`a credential for service "${service}" already exists`);
  }
  const methods = (input.allowedMethods || [])
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
  const prefixes = (input.allowedPathPrefixes || [])
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of prefixes) {
    if (!p.startsWith("/"))
      throw new Error(`path prefix must start with /: ${p}`);
  }
  const now = new Date().toISOString();
  const cred: KeychainCredential = {
    id: `kc-${crypto.randomUUID()}`,
    owner: ownerName(input.owner),
    service,
    host,
    secret: input.secret.trim(),
    ...(input.description ? { description: input.description } : {}),
    ...(input.injection ? { injection: input.injection } : {}),
    ...(methods.length ? { allowedMethods: methods } : {}),
    ...(prefixes.length ? { allowedPathPrefixes: prefixes } : {}),
    createdAt: now,
    updatedAt: now,
  };
  credentials.set(cred.id, cred);
  persist();
  audit({
    kind: "keychain_credential_added",
    credential_id: cred.id,
    owner: cred.owner,
    service: cred.service,
    host: cred.host,
  });
  return meta(cred);
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
  for (const gr of grants.values()) {
    if (gr.credentialId === id && gr.status === "active") {
      gr.status = "revoked";
      gr.revokedAt = new Date().toISOString();
      grants.set(gr.id, gr);
    }
  }
  persist();
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
      now + (mode === "once" ? ONCE_GRANT_TTL_MS : STANDING_GRANT_TTL_MS),
    ).toISOString(),
    askId: ask.id,
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
  method: string,
  path: string,
): BrokerUse | { error: string; status: number } {
  load();
  const gr = grants.get(grantId);
  if (!gr) return { error: "unknown grant", status: 404 };
  settleExpiry(gr);
  if (gr.status !== "active")
    return { error: `grant is ${gr.status}`, status: 403 };
  const cred = credentials.get(gr.credentialId);
  if (!cred) return { error: "credential no longer exists", status: 404 };
  const m = method.toUpperCase();
  if (cred.allowedMethods?.length && !cred.allowedMethods.includes(m)) {
    return {
      error: `method ${m} is not allowed for this credential (allowed: ${cred.allowedMethods.join(", ")})`,
      status: 403,
    };
  }
  if (
    cred.allowedPathPrefixes?.length &&
    !cred.allowedPathPrefixes.some((p) => path.startsWith(p))
  ) {
    return {
      error: `path is outside this credential's allowed prefixes (${cred.allowedPathPrefixes.join(", ")})`,
      status: 403,
    };
  }
  if (gr.mode === "once") {
    gr.status = "used";
    gr.usedAt = new Date().toISOString();
    grants.set(gr.id, gr);
    persist();
  }
  return { credential: cred, grant: gr };
}

export function brokerHeaders(
  cred: KeychainCredential,
): Record<string, string> {
  const header = cred.injection?.header || "Authorization";
  const scheme =
    cred.injection?.scheme ?? (header === "Authorization" ? "Bearer" : "");
  return { [header]: scheme ? `${scheme} ${cred.secret}` : cred.secret };
}

/** Scrub the secret from a text body the remote echoed back. */
export function scrubSecret(body: string, secret: string): string {
  return secret && body.includes(secret)
    ? body.split(secret).join("[redacted]")
    : body;
}

// ── Asks (through the human-asks transport) ─────────────────────────────────

const APPROVE_ONCE = "Approve once";
const APPROVE_STANDING = "Approve standing";
const DECLINE = "Decline";

const KEYCHAIN_ASK_DOMAIN = "keychain-ask";

function brokerBaseUrl(): string {
  const port = parseInt(process.env.PORT || "3850");
  return `http://127.0.0.1:${port}/api/keychain/broker`;
}

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
  return (
    `${gr.owner} approved your keychain ask for **${credMeta.service}** ` +
    `(${gr.mode === "once" ? "one single call" : `standing until ${gr.expiresAt}`}).\n` +
    `Call the service through the broker — the secret itself is never exposed to you:\n\n` +
    "```\n" +
    `curl -sS -X GET '${brokerBaseUrl()}/${gr.id}/<path-on-${credMeta.host}>'\n` +
    "```\n" +
    `The broker injects the credential server-side and proxies to https://${credMeta.host}. ` +
    (limits ? `Limits: ${limits}. ` : "") +
    (gr.mode === "once"
      ? "The grant is SINGLE-USE — the first call consumes it, so make it the right one. "
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
  mode?: GrantMode;
}

export function requestCredential(
  input: RequestCredentialInput,
): { ask: KeychainAskRecord; transport: HumanAsk } | { error: string } {
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

  const pending = [...keychainAsks.values()].find(
    (a) =>
      a.status === "pending" &&
      a.credentialId === credMeta.id &&
      a.sessionId === input.sessionId,
  );
  if (pending)
    return {
      error: `an ask for this credential is already pending (${pending.id})`,
    };

  const record: KeychainAskRecord = {
    id: `ka-${crypto.randomUUID()}`,
    credentialId: credMeta.id,
    owner: credMeta.owner,
    sessionId: input.sessionId,
    requestedBy: input.requestedBy,
    purpose,
    requestedMode: input.mode || "once",
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const transport = registerAsk({
    sessionId: input.sessionId,
    createdBy: input.requestedBy,
    person: { slackId: owner.slackId, name: owner.name },
    question:
      `May this session borrow your **${credMeta.service}** credential ` +
      `(${credMeta.host})?\nPurpose: ${purpose}\nRequested: ${record.requestedMode} ` +
      `(once = a single API call through the broker; standing = 7 days, revocable).`,
    context:
      "_The secret is never shown to the session — approved calls go through the " +
      "keychain broker with method/path limits, and every call is audited._",
    options: [APPROVE_ONCE, APPROVE_STANDING, DECLINE],
    mode: "block",
    deliver: "now",
    domain: { kind: KEYCHAIN_ASK_DOMAIN, ref: record.id },
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
  });
  return { ask: record, transport };
}

export function listKeychainAsks(opts?: {
  sessionId?: string;
}): KeychainAskRecord[] {
  load();
  return [...keychainAsks.values()]
    .filter((a) => !opts?.sessionId || a.sessionId === opts.sessionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Parse the owner's answer (button label or free text). Fail closed: only an
 *  explicit approval approves; anything unrecognized declines with the text
 *  kept as the owner's note. */
export function parseOwnerAnswer(
  answer: string,
  requestedMode: GrantMode,
): { approve: true; mode: GrantMode } | { approve: false; note?: string } {
  const t = answer.trim().toLowerCase();
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

  const verdict = parseOwnerAnswer(answer, record.requestedMode);
  record.resolvedAt = new Date().toISOString();

  if (!verdict.approve) {
    record.status = "declined";
    if (verdict.note) record.note = verdict.note;
    keychainAsks.set(record.id, record);
    persist();
    audit({
      kind: "keychain_ask_declined",
      ask_id: record.id,
      credential_id: record.credentialId,
      ...(record.note ? { note_len: record.note.length } : {}),
    });
    return (
      `${record.owner} declined the keychain ask for this credential` +
      (verdict.note ? ` — "${verdict.note}"` : "") +
      ". Don't retry the same ask; either work without it, or tell the user why you need it " +
      "and let them take it up with the owner."
    );
  }

  record.status = "approved";
  const grant = mintGrant(record, verdict.mode);
  record.grantId = grant.id;
  keychainAsks.set(record.id, record);
  persist();
  audit({
    kind: "keychain_ask_approved",
    ask_id: record.id,
    grant_id: grant.id,
    mode: verdict.mode,
  });
  const credMeta = findCredential(record.credentialId);
  return credMeta ? grantInstructions(grant, credMeta) : null;
}

/** Module-load side effect (re-runs on hot reload, overwriting the handler —
 *  that's the point: the newest code answers). Registered here, next to the
 *  handler, so importing the keychain anywhere wires the resolution path. */
registerAskDomainHandler(KEYCHAIN_ASK_DOMAIN, resolveKeychainAsk);
