/**
 * Short-lived AWS credentials for agent runs.
 *
 * Opt-in. The mint stays inert unless an operator configures it, because it
 * only makes sense on an EC2 host whose service account has passwordless sudo.
 * Off, it does nothing: no subprocess, no sudo, no IMDS curls, no log noise.
 * `agentAwsCredsEnabled` holds the exact gate.
 *
 * When enabled, the opensession service cgroup denies the EC2 metadata
 * endpoint (IPAddressDeny in opensession.service), so neither the main process
 * nor any agent child can reach IMDS directly. That is the per-child isolation
 * that keeps untrusted ticket text from minting the instance role itself.
 *
 * To still hand AWS to runs that need it, the *main* process mints a bounded
 * snapshot of the instance-role's temporary credentials and injects them into
 * the child's env. The mint escapes the cgroup via a transient systemd unit
 * (`systemd-run --pipe`) that runs as an unprivileged account through
 * passwordless sudo, so it and only it can reach IMDS. The child receives a
 * fixed, expiring copy in its env; it cannot refresh them or read any other
 * instance metadata. That account comes from `AGENT_AWS_MINT_USER` or
 * `integrations.aws.mintUser`, defaulting to the account the server runs as.
 *
 * Scope on an instance-role deploy == the instance role (for example the
 * AWS-managed ReadOnlyAccess): account-wide read, no writes. To narrow this,
 * point the helper at an sts:AssumeRole of a tighter role instead of vending
 * the instance creds.
 *
 * Runner run hosts never mint: they run on another machine, outside the
 * cgroup and without the sudo rule. When a run host is a WS dial-back host
 * (the Runner and sandbox launch envs), `getAgentAwsEnv` asks the server for
 * credentials instead (`GET /run-hosts/<hostId>/aws-credentials`, bearer =
 * the run's wsToken). The server answers only for a Runner whose
 * administrator configured an IAM role: it assumes that role with the
 * instance credentials (`assumeRunnerRole`) and vends the role session. The
 * instance credentials themselves stay on the host.
 */

import { stateDir } from "./paths";
import { mkdirSync, renameSync, writeFileSync } from "fs";
import { userInfo } from "os";
import { configuredIntegration } from "./config";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Is the IMDS mint configured? Resolution, first hit wins:
 *
 * 1. `AGENT_AWS_CREDS` in env, where only the literal string `true` enables
 *    (the boot-guard convention: anything unrecognised means off),
 * 2. `integrations.aws.enabled` in config.json,
 * 3. otherwise a region pinned for agent runs (`AGENT_AWS_REGION` or
 *    `integrations.aws.region`) counts as the signal.
 *
 * A bare `AWS_REGION` does not enable it. That variable is set on plenty of
 * laptops and VPSes with no instance role to mint, where turning the helper on
 * costs a sudo attempt and three curl timeouts per session start.
 */
export function agentAwsCredsEnabled(): boolean {
  const flag = process.env.AGENT_AWS_CREDS?.trim();
  if (flag) return flag === "true";
  const cfg = configuredIntegration("aws");
  if (typeof cfg.enabled === "boolean") return cfg.enabled;
  return Boolean(process.env.AGENT_AWS_REGION?.trim() || str(cfg.region));
}

/**
 * Do runs that hold untrusted text (automation runs and Plain discussion
 * sessions, which read customer ticket text) get the vended credentials too?
 * Off by default: the trust gates in run-session.ts, runner-session.ts and
 * session-create.ts withhold AWS from those runs. An operator whose instance
 * role is read-only and whose ticket work needs S3 (raw uploads, recorder
 * logs) turns it on per instance. Resolution, first hit wins:
 *
 * 1. `AGENT_AWS_UNTRUSTED_RUNS` in env, literal `true` only,
 * 2. `integrations.aws.untrustedRuns` in config.json.
 */
export function agentAwsCredsForUntrustedRuns(): boolean {
  const flag = process.env.AGENT_AWS_UNTRUSTED_RUNS?.trim();
  if (flag) return flag === "true";
  return configuredIntegration("aws").untrustedRuns === true;
}

/** Region stamped into the vended env. */
function awsRegion(): string {
  return (
    process.env.AGENT_AWS_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    str(configuredIntegration("aws").region) ||
    "us-east-1"
  );
}

/**
 * The unprivileged account the transient mint unit runs as. It is there so the
 * unit cannot inherit root, not to name a particular deploy, so the server's
 * own account is the right default: it already owns the process and the state
 * directory, and it is the account a sudoers rule is written for.
 */
export function agentAwsMintUser(): string {
  return (
    process.env.AGENT_AWS_MINT_USER?.trim() ||
    str(configuredIntegration("aws").mintUser) ||
    userInfo().username
  );
}

export const AWS_HUMAN_AUTH_DENIAL =
  "AWS device login is not a human gate in Open Session. Do not run `aws login` or " +
  "`aws sso login`, and do not ask anyone to open an AWS authorization URL or enter a " +
  "device code. Open Session supplies non-interactive read credentials to eligible runs. " +
  "If those credentials are unavailable or insufficient, report the infrastructure " +
  "failure and continue without AWS.";

/**
 * Fail closed before a model-authored AWS device-login request can become a UI
 * card or Slack DM. The instruction layer tells agents not to start interactive
 * AWS auth; this is the enforcement layer for resumed sessions and models that
 * ignore that instruction.
 *
 * Keep this narrower than "AWS + login": teammates can still be asked ordinary
 * questions about auth architecture or IAM. We block only requests that ask a
 * human to perform/approve an interactive login or device-code authorization.
 */
export function isAwsHumanAuthRequest(
  ...parts: Array<string | undefined>
): boolean {
  const text = parts.filter(Boolean).join("\n");
  if (!text) return false;
  const aws = /\bAWS\b|Amazon Web Services|awsapps\.com\/start|aws\s+sso/i.test(
    text,
  );
  const interactiveAuth =
    /\b(?:authori[sz]e|approve|authenticate|log\s*in|login|sign\s*in|device\s*(?:login|code|authorization)|enter\s+(?:the\s+)?code)\b/i.test(
      text,
    );
  return aws && interactiveAuth;
}

interface ImdsCreds {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token: string;
  Expiration: string; // ISO 8601
}

// IMDSv2 dance, run inside a transient unit that is NOT in the opensession cgroup
// (so the IMDS deny doesn't apply). Emits only the credentials JSON on stdout.
const FETCH_SCRIPT = [
  'TOKEN=$(curl -s -m 3 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")',
  '[ -z "$TOKEN" ] && exit 11',
  'ROLE=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/)',
  '[ -z "$ROLE" ] && exit 12',
  'curl -s -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/iam/security-credentials/$ROLE"',
].join("\n");

let cache: { env: Record<string, string>; expiresAt: number } | null = null;
// Refresh well before expiry: an assumed role session lasts one hour, and the
// credentials-file ticker below only looks every ten minutes, so a smaller
// skew would let a Runner run sit on an expired file until the next tick.
const REFRESH_SKEW_MS = 15 * 60_000;

/** Wire shape of the server's vended credentials (routes/run-host-aws.ts). */
export interface VendedAwsCreds extends ImdsCreds {
  Region: string;
}

/**
 * Where a WS dial-back host asks for credentials, derived from the launch
 * env every such host already carries (`OPENSESSION_RUN_WS_URL` names the
 * server and the hostId, `OPENSESSION_RUN_WS_TOKEN` is the bearer). Null in
 * the server process and in local unix-socket hosts, which mint instead.
 */
export function remoteVendEndpoint(
  env: Record<string, string | undefined> = process.env,
): { url: string; token: string } | null {
  const runWs = env.OPENSESSION_RUN_WS_URL?.trim();
  const token = env.OPENSESSION_RUN_WS_TOKEN?.trim();
  if (!runWs || !token) return null;
  const m = runWs.match(/^(wss?):\/\/(.+)\/run-ws\/([^/?#]+)$/);
  if (!m) return null;
  const scheme = m[1] === "wss" ? "https" : "http";
  return {
    url: `${scheme}://${m[2]}/run-hosts/${m[3]}/aws-credentials`,
    token,
  };
}

/** Test seam for the host-side fetch. */
export type VendFetch = (
  url: string,
  token: string,
) => Promise<{ status: number; body: string }>;

const httpVend: VendFetch = async (url, token) => {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.text() };
};

// The server says once per host process whether this Runner has a role. A
// 404 is the ordinary answer on a Runner with no role configured and on a
// sandbox host; repeating it per refresh tick is noise.
let announcedRemote = false;

async function fetchVendedCreds(
  endpoint: { url: string; token: string },
  vend: VendFetch,
): Promise<VendedAwsCreds | null> {
  try {
    const { status, body } = await vend(endpoint.url, endpoint.token);
    if (status !== 200) {
      if (!announcedRemote) {
        announcedRemote = true;
        let reason = body.trim().slice(0, 200);
        try {
          reason = String(JSON.parse(body).error ?? reason);
        } catch {}
        console.log(
          `[aws-creds] no AWS credentials from the server (${status}${reason ? `: ${reason}` : ""})`,
        );
      }
      return null;
    }
    const creds = JSON.parse(body);
    if (
      !creds.AccessKeyId ||
      !creds.SecretAccessKey ||
      !creds.Token ||
      !creds.Expiration
    ) {
      console.error("[aws-creds] server vended no usable credentials");
      return null;
    }
    return creds as VendedAwsCreds;
  } catch (e: any) {
    console.error(
      "[aws-creds] failed to fetch vended credentials:",
      e?.message || e,
    );
    return null;
  }
}

/** The command that reaches IMDS, as the mint runs it. */
export function mintCommand(user = agentAwsMintUser()): string[] {
  return [
    "sudo",
    "-n",
    "systemd-run",
    "--pipe",
    "--collect",
    "--quiet",
    `--uid=${user}`,
    `--gid=${user}`,
    "/bin/bash",
    "-c",
    FETCH_SCRIPT,
  ];
}

/** Test seam: run the mint command without a real sudo/systemd on the box. */
export type MintSpawn = (
  argv: string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const systemdMint: MintSpawn = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

async function fetchInstanceCreds(spawn: MintSpawn): Promise<ImdsCreds | null> {
  try {
    const { code, stdout: out, stderr: err } = await spawn(mintCommand());
    if (code !== 0) {
      console.error(
        `[aws-creds] mint helper exited ${code}: ${err.trim().slice(0, 200)}`,
      );
      return null;
    }
    const creds = JSON.parse(out.trim());
    if (!creds.AccessKeyId || !creds.SecretAccessKey || !creds.Token) {
      console.error("[aws-creds] mint helper returned no usable credentials");
      return null;
    }
    return creds as ImdsCreds;
  } catch (e: any) {
    console.error("[aws-creds] failed to mint credentials:", e?.message || e);
    return null;
  }
}

// One line per process, the first time a run asks for AWS on an instance that
// has not configured the mint. Repeating it per session start is the noise
// this gate exists to remove.
let announcedOff = false;

function noteDisabled() {
  if (announcedOff) return;
  announcedOff = true;
  console.log(
    "[aws-creds] agent AWS credentials are off. Set AGENT_AWS_REGION " +
      "(or integrations.aws.region) on an EC2 host to enable the mint.",
  );
}

/**
 * AWS env vars to inject into an agent child. {} when the mint is off, and {}
 * when it is on but minting failed: the run proceeds either way, it just has
 * no AWS, and `aws` calls error visibly rather than us swallowing the problem.
 * Cached until shortly before expiry.
 *
 * In a WS dial-back host (Runner, sandbox) the source is the server's vend
 * endpoint rather than the local mint; the local enable gate does not apply
 * there because the decision was the server's (spec.aws plus the Runner's
 * configured role).
 */
export async function getAgentAwsEnv(
  spawn: MintSpawn = systemdMint,
  vend: VendFetch = httpVend,
): Promise<Record<string, string>> {
  const remote = remoteVendEndpoint();
  if (!remote && !agentAwsCredsEnabled()) {
    noteDisabled();
    return {};
  }
  if (cache && Date.now() < cache.expiresAt - REFRESH_SKEW_MS) return cache.env;

  const creds = remote
    ? await fetchVendedCreds(remote, vend)
    : await fetchInstanceCreds(spawn);
  if (!creds) return cache?.env ?? {}; // fall back to a still-valid cache if any

  const region = remote ? (creds as VendedAwsCreds).Region : awsRegion();
  const env = {
    AWS_ACCESS_KEY_ID: creds.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
    AWS_SESSION_TOKEN: creds.Token,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };
  cache = { env, expiresAt: new Date(creds.Expiration).getTime() };
  console.log(
    `[aws-creds] ${remote ? "received vended" : "minted"} agent credentials, expire ${creds.Expiration}`,
  );
  return env;
}

// ── Runner role sessions (server side) ──────────────────────────────────────────────

export interface AssumeRoleInput {
  roleArn: string;
  externalId?: string;
  /** CloudTrail-visible session name, already sanitized to STS's alphabet. */
  sessionName: string;
  region: string;
  /** The caller's own credentials: the minted instance-role session. */
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
}

/** Test seam: the sts:AssumeRole call itself. */
export type AssumeRole = (input: AssumeRoleInput) => Promise<ImdsCreds>;

const stsAssumeRole: AssumeRole = async (input) => {
  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
  const client = new STSClient({
    region: input.region,
    credentials: input.credentials,
  });
  const out = await client.send(
    new AssumeRoleCommand({
      RoleArn: input.roleArn,
      RoleSessionName: input.sessionName,
      ...(input.externalId ? { ExternalId: input.externalId } : {}),
    }),
  );
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration)
    throw new Error("STS returned no credentials");
  return {
    AccessKeyId: c.AccessKeyId,
    SecretAccessKey: c.SecretAccessKey,
    Token: c.SessionToken,
    Expiration: new Date(c.Expiration).toISOString(),
  };
};

/** STS RoleSessionName: 2-64 characters of [\w+=,.@-]. */
export function roleSessionName(label: string): string {
  const cleaned = `opensession-${label}`
    .replace(/[^\w+=,.@-]+/g, "-")
    .slice(0, 64);
  return cleaned.length >= 2 ? cleaned : "opensession";
}

// roleArn + externalId → the live role session. One role serves every run on
// its Runner, so the sessions are shared and refreshed on the same skew as
// the instance creds they chain from.
const roleCache: Map<string, { creds: VendedAwsCreds; expiresAt: number }> = ((
  globalThis as any
).__opensessionAwsRoleCache ??= new Map());

/** Test seam: forget every cached session so the next call sources again. */
export function __resetAgentAwsCacheForTest(): void {
  cache = null;
  roleCache.clear();
  announcedRemote = false;
}

/**
 * Credentials for a Runner's configured role, assumed with the host's minted
 * instance credentials. Null when the mint is off or failed (the host has
 * nothing to chain from) and when STS refuses (trust policy, external id,
 * a mistyped ARN): the caller reports that and the run proceeds without AWS,
 * the same contract as getAgentAwsEnv.
 */
export async function assumeRunnerRole(
  role: { roleArn: string; externalId?: string },
  sessionName: string,
  deps: { spawn?: MintSpawn; assumeRole?: AssumeRole } = {},
): Promise<VendedAwsCreds | null> {
  const key = `${role.roleArn}\n${role.externalId ?? ""}`;
  const hit = roleCache.get(key);
  if (hit && Date.now() < hit.expiresAt - REFRESH_SKEW_MS) return hit.creds;

  const source = await getAgentAwsEnv(deps.spawn ?? systemdMint);
  if (!source.AWS_ACCESS_KEY_ID) return hit?.creds ?? null;
  try {
    const session = await (deps.assumeRole ?? stsAssumeRole)({
      roleArn: role.roleArn,
      externalId: role.externalId,
      sessionName,
      region: source.AWS_REGION,
      credentials: {
        accessKeyId: source.AWS_ACCESS_KEY_ID,
        secretAccessKey: source.AWS_SECRET_ACCESS_KEY,
        sessionToken: source.AWS_SESSION_TOKEN,
      },
    });
    const creds: VendedAwsCreds = { ...session, Region: source.AWS_REGION };
    roleCache.set(key, {
      creds,
      expiresAt: new Date(session.Expiration).getTime(),
    });
    console.log(
      `[aws-creds] assumed ${role.roleArn} for ${sessionName}, expires ${session.Expiration}`,
    );
    return creds;
  } catch (e: any) {
    console.error(
      `[aws-creds] could not assume ${role.roleArn}:`,
      e?.message || e,
    );
    return hit?.creds ?? null;
  }
}

/**
 * File-vended credentials for pi runs. A Pi run is a
 * long-lived (often shared) process whose env is fixed at spawn — injecting
 * the raw keys there would go stale at expiry, and rotating them through
 * `extraEnv` would churn the server config hash (= drain-respawn) on every
 * refresh. Instead the main process keeps an ini credentials file fresh and
 * the run gets a STATIC pointer env (AWS_SHARED_CREDENTIALS_FILE): the file
 * contents rotate underneath while the env — and the hash — stay put.
 *
 * Returns {} when the mint is off, and when it is on but minting fails (e.g.
 * inside a docker sandbox, where IMDS is blocked for the mint helper too). The
 * run proceeds without AWS and `aws` calls error visibly, same contract as
 * getAgentAwsEnv.
 */
const CREDS_DIR = stateDir("aws");
const CREDS_FILE = `${CREDS_DIR}/agent-credentials`;
const FILE_REFRESH_MS = 10 * 60_000;

export async function ensureAgentAwsCredsFile(
  spawn: MintSpawn = systemdMint,
  vend: VendFetch = httpVend,
): Promise<Record<string, string>> {
  const env = await getAgentAwsEnv(spawn, vend);
  if (!env.AWS_ACCESS_KEY_ID) return {};
  writeCredsFile(env);
  startCredsFileRefresh();
  // A vended session carries its own region; the mint stamps the host's.
  const region = env.AWS_REGION || awsRegion();
  return {
    AWS_SHARED_CREDENTIALS_FILE: CREDS_FILE,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };
}

function writeCredsFile(env: Record<string, string>) {
  const body = [
    "[default]",
    `aws_access_key_id = ${env.AWS_ACCESS_KEY_ID}`,
    `aws_secret_access_key = ${env.AWS_SECRET_ACCESS_KEY}`,
    `aws_session_token = ${env.AWS_SESSION_TOKEN}`,
    "",
  ].join("\n");
  mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CREDS_FILE}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, CREDS_FILE);
}

// Servers outlive any single mint, so the file must keep refreshing after the
// run that created it ends. Parked on globalThis like the other live state so
// a hot reload doesn't stack tickers.
function startCredsFileRefresh() {
  const g = globalThis as {
    __opensessionAwsCredsTicker?: ReturnType<typeof setInterval>;
  };
  if (g.__opensessionAwsCredsTicker) return;
  g.__opensessionAwsCredsTicker = setInterval(() => {
    void getAgentAwsEnv().then((env) => {
      if (env.AWS_ACCESS_KEY_ID) writeCredsFile(env);
    });
  }, FILE_REFRESH_MS);
}
