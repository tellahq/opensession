import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleRunHostAwsRoute, isRunHostAwsRoute } from "./run-host-aws";
import { registerRunWsHost, unregisterRunWsHost } from "../run-ws";
import {
  createRunnerPairing,
  listRunners,
  registerRunner,
  removeRunner,
  updateRunner,
} from "../runners";
import type { assumeRunnerRole } from "../aws-creds";

const HOME = mkdtempSync(join(tmpdir(), "os-run-host-aws-test-"));
const realHome = process.env.HOME;
process.env.HOME = HOME;

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(HOME, { recursive: true, force: true });
});

const HOST = "rh-0123456789ab";
const PATH = `/run-hosts/${HOST}/aws-credentials`;
const ROLE = "arn:aws:iam::123456789012:role/ci";

function pairRunner() {
  const { code } = createRunnerPairing("tester");
  const result = registerRunner({
    code,
    name: "Bill",
    platform: "win32",
    arch: "x64",
    address: "100.101.102.103",
  });
  if (!result.ok) throw new Error(result.error);
  return result.runner;
}

function get(token?: string): Request {
  return new Request(`https://os.example.test${PATH}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const vended = {
  AccessKeyId: "ASIAROLE",
  SecretAccessKey: "rolesecret",
  Token: "roletoken",
  Expiration: "2030-01-01T00:00:00.000Z",
  Region: "eu-west-1",
};

beforeEach(() => {
  for (const runner of listRunners()) removeRunner(runner.id);
  unregisterRunWsHost(HOST);
});

describe("run host AWS credential route", () => {
  test("matches only its own path", () => {
    expect(isRunHostAwsRoute(PATH)).toBe(true);
    expect(isRunHostAwsRoute("/run-hosts/x/other")).toBe(false);
    expect(isRunHostAwsRoute("/api/runners")).toBe(false);
  });

  test("refuses a host without its registered dial-back bearer", async () => {
    const runner = pairRunner();
    updateRunner(runner.id, { aws: { roleArn: ROLE } });
    registerRunWsHost(HOST, "secret", { runnerId: runner.id, aws: true });
    let calls = 0;
    const assume: typeof assumeRunnerRole = async () => {
      calls++;
      return vended;
    };
    expect((await handleRunHostAwsRoute(get(), PATH, { assume })).status).toBe(
      403,
    );
    expect(
      (await handleRunHostAwsRoute(get("wrong"), PATH, { assume })).status,
    ).toBe(403);
    unregisterRunWsHost(HOST);
    expect(
      (await handleRunHostAwsRoute(get("secret"), PATH, { assume })).status,
    ).toBe(403);
    expect(calls).toBe(0);
  });

  test("vends the Runner's role session, never the instance credentials", async () => {
    const runner = pairRunner();
    updateRunner(runner.id, {
      aws: { roleArn: ROLE, externalId: "team-42" },
    });
    registerRunWsHost(HOST, "secret", { runnerId: runner.id, aws: true });
    const seen: Parameters<typeof assumeRunnerRole>[] = [];
    const assume: typeof assumeRunnerRole = async (...args) => {
      seen.push(args);
      return vended;
    };
    const res = await handleRunHostAwsRoute(get("secret"), PATH, {
      assume,
      enabled: () => true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(vended);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toEqual({ roleArn: ROLE, externalId: "team-42" });
    expect(seen[0]![1]).toBe("opensession-Bill");
  });

  test("answers 404 for hosts that are not on a Runner or whose Runner has no role", async () => {
    const assume: typeof assumeRunnerRole = async () => {
      throw new Error("must not assume");
    };
    registerRunWsHost(HOST, "secret");
    expect(
      (await handleRunHostAwsRoute(get("secret"), PATH, { assume })).status,
    ).toBe(404);
    const runner = pairRunner();
    registerRunWsHost(HOST, "secret", { runnerId: runner.id, aws: true });
    const res = await handleRunHostAwsRoute(get("secret"), PATH, { assume });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /No AWS role/,
    );
  });

  test("withholds the role from a run the server withheld AWS from", async () => {
    const runner = pairRunner();
    updateRunner(runner.id, { aws: { roleArn: ROLE } });
    registerRunWsHost(HOST, "secret", { runnerId: runner.id, aws: false });
    const res = await handleRunHostAwsRoute(get("secret"), PATH, {
      assume: async () => vended,
      enabled: () => true,
    });
    expect(res.status).toBe(403);
  });

  test("reports an unconfigured or failing host mint as unavailable", async () => {
    const runner = pairRunner();
    updateRunner(runner.id, { aws: { roleArn: ROLE } });
    registerRunWsHost(HOST, "secret", { runnerId: runner.id, aws: true });
    expect(
      (
        await handleRunHostAwsRoute(get("secret"), PATH, {
          assume: async () => vended,
          enabled: () => false,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await handleRunHostAwsRoute(get("secret"), PATH, {
          assume: async () => null,
          enabled: () => true,
        })
      ).status,
    ).toBe(503);
  });
});
