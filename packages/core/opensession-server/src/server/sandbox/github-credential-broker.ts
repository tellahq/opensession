/**
 * GitHub credentials for Sandbox shell commands, handed out per call.
 *
 * A run's GitHub tokens (GH_TOKEN, GITHUB_TOKEN, GH_READ_TOKEN and the
 * per-owner OPENSESSION_GITHUB_OWNER_TOKEN_*) reach this server with every
 * shell command the run host sends (workspace-rpc.ts). They are kept here, in
 * memory, under the run's bearer, and the command that enters the Sandbox
 * carries none of them. It gets an opaque lease instead, valid only at this
 * server's `/workload-identity/github-token` endpoint and only while the run
 * lives:
 *
 *  - git asks through a credential helper (inline shell and curl, so it needs
 *    nothing installed) each time it talks to github.com;
 *  - `gh` resolves through a small shim placed first on the command's PATH,
 *    which fetches GH_TOKEN for that one process and execs the real binary.
 *
 * The answer is whatever the run host sent last, so a token the run host
 * re-mints mid-turn reaches git and gh on their next call. Nothing is
 * written to disk: after a restart old leases are unknown (401) and the
 * run's next command registers a new one. A lease dies with its run
 * (unregisterRunToken) and its Sandbox (forgetWorkspaceSandbox).
 */

import { createHash, randomBytes } from "crypto";

export const GITHUB_CREDENTIAL_PATH = "/workload-identity/github-token";
export const GITHUB_CREDENTIAL_URL_ENV = "OPENSESSION_GITHUB_CREDENTIAL_URL";
export const GITHUB_CREDENTIAL_TOKEN_ENV =
  "OPENSESSION_GITHUB_CREDENTIAL_TOKEN";

/** An entry no command has refreshed for this long is dropped. Runs send a
 *  command far more often than this; a forgotten one must not live forever. */
const IDLE_TTL_MS = 6 * 60 * 60_000;
const MAX_ENTRIES = 2_000;

const OWNER_TOKEN_PREFIX = "OPENSESSION_GITHUB_OWNER_TOKEN_";
const NAMED_TOKENS = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_READ_TOKEN"]);

/** Whether an environment variable carries a GitHub credential this broker
 *  keeps out of the Sandbox. */
export function isBrokeredGithubVariable(name: string): boolean {
  return (
    NAMED_TOKENS.has(name) ||
    (name.startsWith(OWNER_TOKEN_PREFIX) &&
      /^[A-Za-z0-9_]+$/.test(name.slice(OWNER_TOKEN_PREFIX.length)))
  );
}

type Entry = {
  runToken: string;
  sessionId: string;
  sandboxId: string;
  leaseHash: string;
  lease: string;
  credentials: Map<string, string>;
  seenAt: number;
};

type BrokerGlobals = {
  __opensessionGithubBrokerByRun?: Map<string, Entry>;
  __opensessionGithubBrokerByLease?: Map<string, Entry>;
};
const g = globalThis as BrokerGlobals;
const byRun = (g.__opensessionGithubBrokerByRun ??= new Map());
const byLease = (g.__opensessionGithubBrokerByLease ??= new Map());

function hashLease(lease: string): string {
  return createHash("sha256").update(lease).digest("hex");
}

function drop(entry: Entry): void {
  if (byRun.get(entry.runToken) === entry) byRun.delete(entry.runToken);
  if (byLease.get(entry.leaseHash) === entry) byLease.delete(entry.leaseHash);
}

function prune(now: number): void {
  for (const entry of byRun.values())
    if (now - entry.seenAt > IDLE_TTL_MS) drop(entry);
  while (byRun.size > MAX_ENTRIES) {
    const oldest = byRun.values().next().value as Entry | undefined;
    if (!oldest) break;
    drop(oldest);
  }
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The git credential helper that asks this server for `variable`'s current
 *  value. Plain shell and curl: it works in every Sandbox image, with or
 *  without the uploaded client. Anything but a token is no answer, so git
 *  fails non-interactively (GIT_TERMINAL_PROMPT=0) instead of guessing. */
export function brokeredGitCredentialHelper(variable: string): string {
  return (
    `!f() { test "$1" = get || exit 0; ` +
    `t=$(curl -fsS --max-time 30 -H "Authorization: Bearer $${GITHUB_CREDENTIAL_TOKEN_ENV}" ` +
    `--data-urlencode name=${variable} "$${GITHUB_CREDENTIAL_URL_ENV}" 2>/dev/null) || exit 0; ` +
    `test -n "$t" || exit 0; echo username=x-access-token; echo "password=$t"; }; f`
  );
}

/** Bump when the shim's contents change, so every Sandbox rewrites it. */
const GH_SHIM_MARKER = "opensession-gh-shim-v1";
/** Where the real gh lives in every Sandbox image (bootstrap.ts). */
const REAL_GH = "/usr/local/bin/gh";

export function githubShimDir(home: string): string {
  return `${home}/.local/share/opensession/gh-shim`;
}

/** The `gh` placed first on a brokered command's PATH: it fetches GH_TOKEN
 *  for this one process unless the caller set GH_TOKEN or GITHUB_TOKEN, then
 *  execs the real gh. */
export function ghShimSource(): string {
  return [
    "#!/bin/sh",
    `# ${GH_SHIM_MARKER}: gh with a GitHub token fetched from Open Session for this call.`,
    `if [ -z "$GH_TOKEN" ] && [ -z "$GITHUB_TOKEN" ] && [ -n "$${GITHUB_CREDENTIAL_TOKEN_ENV}" ]; then`,
    `  if GH_TOKEN=$(curl -fsS --max-time 30 -H "Authorization: Bearer $${GITHUB_CREDENTIAL_TOKEN_ENV}" --data-urlencode name=GH_TOKEN "$${GITHUB_CREDENTIAL_URL_ENV}" 2>/dev/null) && [ -n "$GH_TOKEN" ]; then`,
    "    export GH_TOKEN",
    "  else",
    "    unset GH_TOKEN",
    '    echo "gh: Open Session handed out no GitHub token for this command; running without one" >&2',
    "  fi",
    "fi",
    `exec ${REAL_GH} "$@"`,
    "",
  ].join("\n");
}

/** Shell that (re)writes the shim when it is missing or out of date. Cheap
 *  enough to run before every brokered command, which keeps a Sandbox
 *  bootstrapped before this existed working without a re-bootstrap. */
export function ghShimEnsureScript(home: string): string {
  const dir = githubShimDir(home);
  const file = `${dir}/gh`;
  return (
    `grep -q ${GH_SHIM_MARKER} ${shellQuote(file)} 2>/dev/null || ` +
    `{ mkdir -p ${shellQuote(dir)} && ` +
    `printf %s ${shellQuote(ghShimSource())} > ${shellQuote(`${file}.tmp`)} && ` +
    `chmod 755 ${shellQuote(`${file}.tmp`)} && ` +
    `mv -f ${shellQuote(`${file}.tmp`)} ${shellQuote(file)}; } 2>/dev/null`
  );
}

const INLINE_HELPER =
  /^!f\(\) \{ .*echo "password=\$\{?([A-Za-z0-9_]+)\}?"; \}; f$/;

/**
 * Take the GitHub credentials out of a command's environment and keep them
 * for this run. Returns the environment the Sandbox gets: no tokens, the
 * lease and endpoint, credential helpers that ask the endpoint, and the gh
 * shim first on PATH. An environment without a GitHub credential comes back
 * unchanged.
 */
export function brokerGithubCredentials(input: {
  runToken: string;
  sessionId: string;
  sandboxId: string;
  env: Record<string, string>;
  /** The credential endpoint's URL, as the Sandbox reaches it. */
  endpoint: string;
  /** The guest user's home (shim location). */
  home: string;
  now?: number;
}): { env: Record<string, string>; brokered: boolean } {
  const credentials = new Map<string, string>();
  for (const [key, value] of Object.entries(input.env))
    if (isBrokeredGithubVariable(key) && value) credentials.set(key, value);
  if (!credentials.size) return { env: input.env, brokered: false };

  const now = input.now ?? Date.now();
  prune(now);
  let entry = byRun.get(input.runToken);
  if (entry && entry.sandboxId !== input.sandboxId) {
    drop(entry);
    entry = undefined;
  }
  if (!entry) {
    const lease = randomBytes(32).toString("base64url");
    entry = {
      runToken: input.runToken,
      sessionId: input.sessionId,
      sandboxId: input.sandboxId,
      lease,
      leaseHash: hashLease(lease),
      credentials,
      seenAt: now,
    };
    byRun.set(input.runToken, entry);
    byLease.set(entry.leaseHash, entry);
  }
  entry.credentials = credentials;
  entry.seenAt = now;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env))
    if (!isBrokeredGithubVariable(key)) env[key] = value;
  for (let index = 0; ; index++) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    if (key === undefined) break;
    if (!/^credential\..*\.helper$/.test(key)) continue;
    const variable =
      env[`GIT_CONFIG_VALUE_${index}`]?.match(INLINE_HELPER)?.[1];
    if (variable && isBrokeredGithubVariable(variable))
      env[`GIT_CONFIG_VALUE_${index}`] = brokeredGitCredentialHelper(variable);
  }
  env[GITHUB_CREDENTIAL_URL_ENV] = input.endpoint;
  env[GITHUB_CREDENTIAL_TOKEN_ENV] = entry.lease;
  const shim = githubShimDir(input.home);
  env.PATH = env.PATH ? `${shim}:${env.PATH}` : shim;
  return { env, brokered: true };
}

/** Forget a run's credentials; its lease stops working at once. */
export function revokeGithubCredentialsForRun(runToken: string): void {
  const entry = byRun.get(runToken);
  if (entry) drop(entry);
}

/** Forget every run's credentials for a Sandbox being retired. */
export function revokeGithubCredentialsForSandbox(sandboxId: string): void {
  for (const entry of [...byRun.values()])
    if (entry.sandboxId === sandboxId) drop(entry);
}

/** Look up one credential by lease. Exported for tests and the endpoint. */
export function brokeredGithubCredential(
  lease: string,
  name: string,
  now = Date.now(),
): { ok: true; value: string } | { ok: false; status: 401 | 404 } {
  const entry = byLease.get(hashLease(lease));
  if (!entry || now - entry.seenAt > IDLE_TTL_MS) {
    if (entry) drop(entry);
    return { ok: false, status: 401 };
  }
  const value = entry.credentials.get(name);
  return value ? { ok: true, value } : { ok: false, status: 404 };
}

/** `POST /workload-identity/github-token` with `Authorization: Bearer
 *  <lease>` and a form body `name=<variable>`: the variable's current value
 *  as plain text. Undefined for any other request. */
export async function handleGithubCredentialRequest(
  req: Request,
): Promise<Response | undefined> {
  if (new URL(req.url).pathname !== GITHUB_CREDENTIAL_PATH) return undefined;
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const lease = (req.headers.get("authorization") || "").match(
    /^Bearer (.+)$/i,
  )?.[1];
  if (!lease) return new Response("Unauthorized", { status: 401 });
  let name = "";
  try {
    name = new URLSearchParams(await req.text()).get("name") || "";
  } catch {
    return new Response("Invalid body", { status: 400 });
  }
  if (!isBrokeredGithubVariable(name))
    return new Response("Unknown credential", { status: 400 });
  const found = brokeredGithubCredential(lease, name);
  if (!found.ok)
    return new Response(
      found.status === 401 ? "Unauthorized" : "No such credential",
      { status: found.status },
    );
  return new Response(found.value, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
