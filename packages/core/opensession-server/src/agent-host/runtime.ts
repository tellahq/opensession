import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { decodeAgentHostSupervisionPublicKeyringV2 } from "@tellahq/opensession-protocol";
import type { AgentTurnDriver } from "./driver";
import { createAgentHost } from "./host";
import type { HostLedgerKeyringInput } from "./ledger-crypto";
import { SQLiteHostRecoveryLedger } from "./sqlite-ledger";
import { assertInheritedUnixListenerDescriptor } from "../server/security/transport/unix-socket-security";

export const AGENT_HOST_MAX_GENERATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const AGENT_HOST_DRAIN_TIMEOUT_MS = 15_000;
const CREDENTIAL_LIMIT = 64 * 1024;
const GENERATION = /^[1-9][0-9]{0,9}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface AgentHostRuntimeOptions {
  readonly generation: string;
  readonly expectedGatewayUid: number;
  readonly expectedHostUid: number;
  readonly doctor?: boolean;
  readonly now?: () => number;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function decodeSecret(value: unknown, minimum: number, exact?: number): Uint8Array | undefined {
  if (typeof value !== "string" || !B64URL.test(value) || value.includes("=")) return undefined;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || bytes.byteLength < minimum || (exact !== undefined && bytes.byteLength !== exact)) return undefined;
  return bytes;
}

export function decodeHostLedgerCredential(value: unknown): HostLedgerKeyringInput {
  if (!exactRecord(value, ["version", "activeKeyId", "keys"]) || value.version !== 1 ||
      typeof value.activeKeyId !== "string" || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 4)
    throw new Error("Malformed Agent Host ledger credential");
  const keys: HostLedgerKeyringInput["keys"][number][] = [];
  const seen = new Set<string>();
  for (const candidate of value.keys) {
    if (!exactRecord(candidate, ["id", "encryptionKey", "lookupKey", "decryptNotBeforeMs", "decryptNotAfterMs"]) ||
        typeof candidate.id !== "string" || seen.has(candidate.id) ||
        !Number.isSafeInteger(candidate.decryptNotBeforeMs) || !Number.isSafeInteger(candidate.decryptNotAfterMs))
      throw new Error("Malformed Agent Host ledger credential");
    const encryptionKey = decodeSecret(candidate.encryptionKey, 32, 32);
    const lookupKey = decodeSecret(candidate.lookupKey, 32);
    if (!encryptionKey || !lookupKey) throw new Error("Malformed Agent Host ledger credential");
    seen.add(candidate.id);
    keys.push({
      id: candidate.id,
      encryptionKey,
      lookupKey,
      decryptNotBeforeMs: candidate.decryptNotBeforeMs as number,
      decryptNotAfterMs: candidate.decryptNotAfterMs as number,
    });
  }
  return { activeKeyId: value.activeKeyId, keys, maxOldKeys: 3 };
}

export async function readSystemdCredential(
  name: string,
  directory = process.env.CREDENTIALS_DIRECTORY,
  expectedOwnerUid = 0,
): Promise<unknown> {
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory)
    throw new Error("Systemd credential directory is unavailable");
  const path = join(directory, name);
  const [directoryReal, stat] = await Promise.all([realpath(directory), lstat(path)]);
  if (dirname(await realpath(path)) !== directoryReal || !stat.isFile() || stat.isSymbolicLink() ||
      stat.uid !== expectedOwnerUid || (stat.mode & 0o7777) !== 0o400 || stat.nlink !== 1 || stat.size < 2 || stat.size > CREDENTIAL_LIMIT)
    throw new Error(`Systemd credential ${name} failed ownership or mode validation`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Systemd credential ${name} is malformed`);
  }
}

interface SocketActivationEnvironment {
  LISTEN_PID?: string;
  LISTEN_FDS?: string;
  LISTEN_FDNAMES?: string;
}

export function inheritedActivationFd(
  env?: SocketActivationEnvironment,
  pid = process.pid,
): number {
  const activation = env ?? process.env;
  if (activation.LISTEN_PID !== String(pid) || activation.LISTEN_FDS !== "1" || activation.LISTEN_FDNAMES !== "agent-host")
    throw new Error("Exactly one named systemd Agent Host socket is required");
  return 3;
}

export async function generationLedgerPath(generation: string, stateDirectory = process.env.STATE_DIRECTORY): Promise<string> {
  if (!GENERATION.test(generation) || !stateDirectory || !isAbsolute(stateDirectory) || resolve(stateDirectory) !== stateDirectory || basename(stateDirectory) !== generation)
    throw new Error("Agent Host generation StateDirectory is invalid");
  const stat = await lstat(stateDirectory);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700)
    throw new Error("Agent Host generation StateDirectory failed ownership or mode validation");
  return join(stateDirectory, "recovery-ledger.sqlite");
}

function unavailableDriver(): AgentTurnDriver {
  return {
    async run() { return { status: "failed", error: "Agent Host production routing is not activated" }; },
    async deliverOperationStream() { throw new Error("Agent Host production routing is not activated"); },
    async cancel() {},
    async shutdown() {},
  };
}

export function installBoundedSignalDrain(
  drain: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
  timeoutMs = AGENT_HOST_DRAIN_TIMEOUT_MS,
): () => void {
  let draining = false;
  return () => {
    if (draining) return;
    draining = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      drain(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Agent Host drain timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]).then(() => exit(0), () => exit(1)).finally(() => { if (timer) clearTimeout(timer); });
  };
}

export async function runAgentHost(options: AgentHostRuntimeOptions): Promise<void> {
  if (
    !GENERATION.test(options.generation) ||
    !Number.isSafeInteger(options.expectedGatewayUid) ||
    options.expectedGatewayUid <= 0 ||
    !Number.isSafeInteger(options.expectedHostUid) ||
    options.expectedHostUid <= 0 ||
    process.getuid?.() !== options.expectedHostUid ||
    options.expectedHostUid === options.expectedGatewayUid
  )
    throw new Error("Invalid Agent Host generation or service UID boundary");
  const fd = inheritedActivationFd();
  await assertInheritedUnixListenerDescriptor(fd);
  const [ledgerValue, supervisionValue, dbPath] = await Promise.all([
    readSystemdCredential("agent-host-ledger-keyring"),
    readSystemdCredential("agent-host-supervision-keyring"),
    generationLedgerPath(options.generation),
  ]);
  const ledgerKeyring = decodeHostLedgerCredential(ledgerValue);
  const supervisionKeyring = decodeAgentHostSupervisionPublicKeyringV2(supervisionValue);
  if (!supervisionKeyring) throw new Error("Malformed Agent Host supervision public keyring credential");
  let ledger: SQLiteHostRecoveryLedger;
  try {
    ledger = new SQLiteHostRecoveryLedger({
      dbPath,
      keyring: ledgerKeyring,
      writerNonce: crypto.randomUUID(),
      now: options.now,
    });
  } finally {
    for (const key of ledgerKeyring.keys) {
      key.encryptionKey.fill(0);
      key.lookupKey.fill(0);
    }
  }
  if (options.doctor) {
    ledger.close();
    return;
  }
  let host;
  try {
    host = createAgentHost({
      inheritedFd: fd,
      expectedPeerUid: options.expectedGatewayUid,
      createDriver: unavailableDriver,
      hostId: `agent-host-${options.generation}`,
      hostGeneration: Number(options.generation),
      hostIncarnation: crypto.randomUUID(),
      supervisionKeyring,
    });
    await host.start();
  } catch (error) {
    ledger.close();
    throw error;
  }
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  const drain = installBoundedSignalDrain(async () => {
    if (lifetime) clearTimeout(lifetime);
    await host.stop();
    ledger.close();
  });
  process.once("SIGTERM", drain);
  process.once("SIGINT", drain);
  lifetime = setTimeout(drain, AGENT_HOST_MAX_GENERATION_LIFETIME_MS);
  lifetime.unref?.();
}
