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
const REFRESH_SKEW_MS = 5 * 60_000; // refresh 5 min before expiry

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
 */
export async function getAgentAwsEnv(
  spawn: MintSpawn = systemdMint,
): Promise<Record<string, string>> {
  if (!agentAwsCredsEnabled()) {
    noteDisabled();
    return {};
  }
  if (cache && Date.now() < cache.expiresAt - REFRESH_SKEW_MS) return cache.env;

  const creds = await fetchInstanceCreds(spawn);
  if (!creds) return cache?.env ?? {}; // fall back to a still-valid cache if any

  const region = awsRegion();
  const env = {
    AWS_ACCESS_KEY_ID: creds.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
    AWS_SESSION_TOKEN: creds.Token,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };
  cache = { env, expiresAt: new Date(creds.Expiration).getTime() };
  console.log(
    `[aws-creds] minted agent credentials, expire ${creds.Expiration}`,
  );
  return env;
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
): Promise<Record<string, string>> {
  const env = await getAgentAwsEnv(spawn);
  if (!env.AWS_ACCESS_KEY_ID) return {};
  writeCredsFile(env);
  startCredsFileRefresh();
  const region = awsRegion();
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
