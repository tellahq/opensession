#!/usr/bin/env bun
/** The sandbox-only client behind `opensession sandbox id-token`. */

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export {};

const usage =
  "usage: opensession sandbox id-token --audience <audience> [--ttl-seconds <60..3600>] [--refresh-file <path>]";

function fail(message: string): never {
  console.error(`opensession sandbox id-token: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] !== "sandbox" || args[1] !== "id-token") {
  fail(usage);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const audience = option("--audience");
const rawTtl = option("--ttl-seconds");
const refreshFile = option("--refresh-file");
const optionNames = new Set(["--audience", "--ttl-seconds", "--refresh-file"]);
if (
  !audience ||
  (rawTtl !== undefined && rawTtl.startsWith("-")) ||
  (refreshFile !== undefined && refreshFile.startsWith("-")) ||
  args.some((arg) => arg.startsWith("-") && !optionNames.has(arg))
) {
  fail(usage);
}
const parsedTtl = rawTtl === undefined ? undefined : Number(rawTtl);
if (
  parsedTtl !== undefined &&
  (!Number.isInteger(parsedTtl) || parsedTtl < 60 || parsedTtl > 3600)
) {
  fail("--ttl-seconds must be an integer between 60 and 3600");
}
const ttlSeconds: number | undefined = parsedTtl;
const endpoint = process.env.OPENSESSION_WORKLOAD_IDENTITY_URL;
const exchangeToken = process.env.OPENSESSION_WORKLOAD_IDENTITY_TOKEN;
if (!endpoint || !exchangeToken) {
  fail(
    "this command is available only inside an OpenSession-managed sandbox command",
  );
}
const endpointUrl = endpoint;
const exchangeCredential = exchangeToken;

async function mintToken(): Promise<string> {
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${exchangeCredential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audience,
      ...(ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }),
    }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${response.status} ${text || response.statusText}`);
  return text.trim();
}

async function writeTokenFile(token: string): Promise<void> {
  const directory = dirname(refreshFile!);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${refreshFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, refreshFile!);
  await chmod(refreshFile!, 0o600);
}

if (!refreshFile) {
  try {
    process.stdout.write(`${await mintToken()}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
} else {
  const refreshEveryMs =
    Math.max(15, Math.floor((ttlSeconds ?? 600) / 2)) * 1_000;
  let stopping = false;
  let wake: (() => void) | undefined;
  const wait = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, milliseconds);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      await writeTokenFile(await mintToken());
      await wait(refreshEveryMs);
    } catch (error) {
      console.error(
        `opensession sandbox id-token: ${error instanceof Error ? error.message : String(error)}`,
      );
      await wait(15_000);
    }
  }
}
