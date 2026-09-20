import { getConfigAsync } from "./config";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import {
  AWS_HUMAN_AUTH_DENIAL,
  __resetAgentAwsCacheForTest,
  agentAwsCredsEnabled,
  agentAwsCredsForUntrustedRuns,
  agentAwsMintUser,
  assumeRunnerRole,
  ensureAgentAwsCredsFile,
  getAgentAwsEnv,
  isAwsHumanAuthRequest,
  mintCommand,
  remoteVendEndpoint,
  roleSessionName,
  type AssumeRoleInput,
  type MintSpawn,
  type VendFetch,
} from "./aws-creds";
import { makeAskHandler } from "./asks";

describe("AWS human-auth guard", () => {
  test("blocks AWS SSO device authorization requests", () => {
    expect(
      isAwsHumanAuthRequest(
        "AWS login",
        "Please authorize stage log access at https://d-9a67574b8b.awsapps.com/start/#/device with code XBBV-XSJV.",
      ),
    ).toBe(true);
    expect(
      isAwsHumanAuthRequest(
        "Please approve the AWS SSO device login and enter the code.",
      ),
    ).toBe(true);
    expect(
      isAwsHumanAuthRequest(
        "Open the Amazon Web Services device authorization page and sign in.",
      ),
    ).toBe(true);
  });

  test("does not block ordinary AWS or unrelated login questions", () => {
    expect(isAwsHumanAuthRequest("Which IAM role should stage logs use?")).toBe(
      false,
    );
    expect(isAwsHumanAuthRequest("Can you review this AWS policy?")).toBe(
      false,
    );
    expect(isAwsHumanAuthRequest("Please sign in to GitHub.")).toBe(false);
  });

  test("denial tells the agent to stop interactive auth and degrade gracefully", () => {
    expect(AWS_HUMAN_AUTH_DENIAL).toContain("Do not run `aws login`");
    expect(AWS_HUMAN_AUTH_DENIAL).toContain("do not ask anyone");
    expect(AWS_HUMAN_AUTH_DENIAL).toContain("continue without AWS");
  });

  test("ask_user rejects the request before opening a human question", async () => {
    const result = await makeAskHandler("test-aws-auth-guard")({
      questions: [
        {
          header: "AWS login",
          question:
            "Please authorize stage log access at https://d-9a67574b8b.awsapps.com/start/#/device with code XBBV-XSJV, then confirm when complete?",
        },
      ],
    });
    expect(result).toEqual({
      behavior: "deny",
      message: AWS_HUMAN_AUTH_DENIAL,
    });
  });
});

describe("IMDS mint gate", () => {
  const ENV_KEYS = [
    "AGENT_AWS_CREDS",
    "AGENT_AWS_UNTRUSTED_RUNS",
    "AGENT_AWS_REGION",
    "AGENT_AWS_MINT_USER",
    "AWS_REGION",
    "OPENSESSION_CONFIG",
    "OPENSESSION_RUN_WS_URL",
    "OPENSESSION_RUN_WS_TOKEN",
  ];
  let saved: Record<string, string | undefined> = {};
  let dir = "";

  /** A spawn that fails the test if the mint reaches it, plus a call log. */
  const calls: string[][] = [];
  const refuse: MintSpawn = async (argv) => {
    calls.push(argv);
    throw new Error("the mint must not spawn anything when it is off");
  };

  async function writeConfig(body: unknown) {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(body));
    process.env.OPENSESSION_CONFIG = path;
    await getConfigAsync();
  }

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    calls.length = 0;
    __resetAgentAwsCacheForTest();
    dir = mkdtempSync(join(tmpdir(), "aws-creds-test-"));
    await writeConfig({});
  });

  const minted = {
    AccessKeyId: "AKIAFAKE",
    SecretAccessKey: "secret",
    Token: "token",
    Expiration: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  };
  const mint: MintSpawn = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: JSON.stringify(minted), stderr: "" };
  };

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("stays off with nothing configured", async () => {
    expect(agentAwsCredsEnabled()).toBe(false);
    expect(await getAgentAwsEnv(refuse)).toEqual({});
    expect(await ensureAgentAwsCredsFile(refuse)).toEqual({});
    expect(calls).toEqual([]);
  });

  test("a bare AWS_REGION is not an enable signal", async () => {
    process.env.AWS_REGION = "eu-west-2";
    expect(agentAwsCredsEnabled()).toBe(false);
    expect(await getAgentAwsEnv(refuse)).toEqual({});
    expect(calls).toEqual([]);
  });

  test("AGENT_AWS_CREDS enables only on the literal string true", () => {
    process.env.AGENT_AWS_REGION = "us-east-1";
    process.env.AGENT_AWS_CREDS = "1";
    expect(agentAwsCredsEnabled()).toBe(false);
    process.env.AGENT_AWS_CREDS = "false";
    expect(agentAwsCredsEnabled()).toBe(false);
    process.env.AGENT_AWS_CREDS = "true";
    expect(agentAwsCredsEnabled()).toBe(true);
  });

  test("config enables it without any env var", async () => {
    await writeConfig({ integrations: { aws: { region: "eu-central-1" } } });
    expect(agentAwsCredsEnabled()).toBe(true);
    await writeConfig({
      integrations: { aws: { enabled: false, region: "eu-central-1" } },
    });
    expect(agentAwsCredsEnabled()).toBe(false);
  });

  test("untrusted runs get AWS only when the instance opts them in", async () => {
    await writeConfig({ integrations: { aws: { region: "eu-central-1" } } });
    expect(agentAwsCredsForUntrustedRuns()).toBe(false);
    await writeConfig({
      integrations: { aws: { region: "eu-central-1", untrustedRuns: true } },
    });
    expect(agentAwsCredsForUntrustedRuns()).toBe(true);
    process.env.AGENT_AWS_UNTRUSTED_RUNS = "false";
    expect(agentAwsCredsForUntrustedRuns()).toBe(false);
    process.env.AGENT_AWS_UNTRUSTED_RUNS = "true";
    await writeConfig({});
    expect(agentAwsCredsForUntrustedRuns()).toBe(true);
    process.env.AGENT_AWS_UNTRUSTED_RUNS = "1";
    expect(agentAwsCredsForUntrustedRuns()).toBe(false);
  });

  test("the mint unit runs as the configured user, never a hardcoded one", async () => {
    expect(agentAwsMintUser()).toBe(userInfo().username);
    await writeConfig({ integrations: { aws: { mintUser: "opensession" } } });
    expect(agentAwsMintUser()).toBe("opensession");
    process.env.AGENT_AWS_MINT_USER = "runner";
    expect(agentAwsMintUser()).toBe("runner");
    expect(mintCommand()).toContain("--uid=runner");
    expect(mintCommand()).toContain("--gid=runner");
  });

  test("an enabled mint spawns as the configured user and vends its region", async () => {
    process.env.AGENT_AWS_REGION = "eu-west-1";
    process.env.AGENT_AWS_MINT_USER = "runner";
    const spawn: MintSpawn = async (argv) => {
      calls.push(argv);
      return {
        code: 0,
        stdout: JSON.stringify({
          AccessKeyId: "AKIAFAKE",
          SecretAccessKey: "secret",
          Token: "token",
          Expiration: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        stderr: "",
      };
    };

    const env = await getAgentAwsEnv(spawn);
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAFAKE");
    expect(env.AWS_REGION).toBe("eu-west-1");
    expect(env.AWS_DEFAULT_REGION).toBe("eu-west-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(mintCommand("runner"));
    expect(calls[0]!.join(" ")).not.toContain("ubuntu");
    expect(calls[0]!.slice(0, 3)).toEqual(["sudo", "-n", "systemd-run"]);

    // Cached until shortly before expiry: a second run mints nothing.
    expect(await getAgentAwsEnv(spawn)).toEqual(env);
    expect(calls).toHaveLength(1);
  });

  test("the vend endpoint is derived from the dial-back launch env only", () => {
    expect(remoteVendEndpoint({})).toBeNull();
    expect(
      remoteVendEndpoint({
        OPENSESSION_RUN_WS_URL: "wss://os.example.test/run-ws/rh-abc",
      }),
    ).toBeNull();
    expect(
      remoteVendEndpoint({
        OPENSESSION_RUN_WS_URL: "wss://os.example.test/run-ws/rh-abc",
        OPENSESSION_RUN_WS_TOKEN: "tok",
      }),
    ).toEqual({
      url: "https://os.example.test/run-hosts/rh-abc/aws-credentials",
      token: "tok",
    });
    expect(
      remoteVendEndpoint({
        OPENSESSION_RUN_WS_URL: "ws://100.64.0.1:3000/run-ws/rh-abc",
        OPENSESSION_RUN_WS_TOKEN: "tok",
      })?.url,
    ).toBe("http://100.64.0.1:3000/run-hosts/rh-abc/aws-credentials");
  });

  test("a dial-back run host fetches vended credentials and never mints", async () => {
    process.env.OPENSESSION_RUN_WS_URL = "wss://os.example.test/run-ws/rh-abc";
    process.env.OPENSESSION_RUN_WS_TOKEN = "tok";
    const fetched: Array<[string, string]> = [];
    const vend: VendFetch = async (url, token) => {
      fetched.push([url, token]);
      return {
        status: 200,
        body: JSON.stringify({
          AccessKeyId: "ASIAROLE",
          SecretAccessKey: "rolesecret",
          Token: "roletoken",
          Expiration: new Date(Date.now() + 3_600_000).toISOString(),
          Region: "eu-west-1",
        }),
      };
    };
    // The local mint gate is irrelevant on a Runner: nothing is configured
    // here and the credentials still arrive, from the server.
    expect(agentAwsCredsEnabled()).toBe(false);
    const env = await getAgentAwsEnv(refuse, vend);
    expect(env).toEqual({
      AWS_ACCESS_KEY_ID: "ASIAROLE",
      AWS_SECRET_ACCESS_KEY: "rolesecret",
      AWS_SESSION_TOKEN: "roletoken",
      AWS_REGION: "eu-west-1",
      AWS_DEFAULT_REGION: "eu-west-1",
    });
    expect(calls).toEqual([]);
    expect(fetched).toEqual([
      ["https://os.example.test/run-hosts/rh-abc/aws-credentials", "tok"],
    ]);
    expect(await getAgentAwsEnv(refuse, vend)).toEqual(env);
    expect(fetched).toHaveLength(1);
  });

  test("a Runner without a role leaves the run without AWS", async () => {
    process.env.OPENSESSION_RUN_WS_URL = "wss://os.example.test/run-ws/rh-abc";
    process.env.OPENSESSION_RUN_WS_TOKEN = "tok";
    const vend: VendFetch = async () => ({
      status: 404,
      body: JSON.stringify({ error: "No AWS role is configured" }),
    });
    expect(await getAgentAwsEnv(refuse, vend)).toEqual({});
    expect(await ensureAgentAwsCredsFile(refuse, vend)).toEqual({});
    expect(calls).toEqual([]);
  });

  test("assumeRunnerRole chains from the minted instance session and caches per role", async () => {
    process.env.AGENT_AWS_REGION = "eu-west-1";
    const assumed: AssumeRoleInput[] = [];
    const assumeRole = async (input: AssumeRoleInput) => {
      assumed.push(input);
      return {
        AccessKeyId: "ASIAROLE",
        SecretAccessKey: "rolesecret",
        Token: "roletoken",
        Expiration: new Date(Date.now() + 3_600_000).toISOString(),
      };
    };
    const role = {
      roleArn: "arn:aws:iam::123456789012:role/ci",
      externalId: "team-42",
    };
    const creds = await assumeRunnerRole(role, "opensession-bill", {
      spawn: mint,
      assumeRole,
    });
    expect(creds).toMatchObject({
      AccessKeyId: "ASIAROLE",
      Token: "roletoken",
      Region: "eu-west-1",
    });
    // The instance session is only ever the source, never the answer.
    expect(creds?.AccessKeyId).not.toBe(minted.AccessKeyId);
    expect(assumed).toEqual([
      {
        roleArn: role.roleArn,
        externalId: "team-42",
        sessionName: "opensession-bill",
        region: "eu-west-1",
        credentials: {
          accessKeyId: "AKIAFAKE",
          secretAccessKey: "secret",
          sessionToken: "token",
        },
      },
    ]);
    expect(
      await assumeRunnerRole(role, "opensession-bill", {
        spawn: mint,
        assumeRole,
      }),
    ).toEqual(creds);
    expect(assumed).toHaveLength(1);
    // A different role is its own session.
    await assumeRunnerRole(
      { roleArn: "arn:aws:iam::123456789012:role/other" },
      "opensession-bill",
      { spawn: mint, assumeRole },
    );
    expect(assumed).toHaveLength(2);
    expect(assumed[1]!.externalId).toBeUndefined();
  });

  test("assumeRunnerRole yields nothing when the host has no instance session or STS refuses", async () => {
    const role = { roleArn: "arn:aws:iam::123456789012:role/ci" };
    const refuseSts = async () => {
      throw new Error("must not be called");
    };
    // Mint off: nothing to chain from.
    expect(
      await assumeRunnerRole(role, "opensession-bill", {
        spawn: refuse,
        assumeRole: refuseSts,
      }),
    ).toBeNull();
    process.env.AGENT_AWS_REGION = "eu-west-1";
    expect(
      await assumeRunnerRole(role, "opensession-bill", {
        spawn: mint,
        assumeRole: async () => {
          throw new Error("AccessDenied");
        },
      }),
    ).toBeNull();
  });

  test("role session names fit STS's alphabet and length", () => {
    expect(roleSessionName("Bill")).toBe("opensession-Bill");
    expect(roleSessionName("bill's mini pc #2")).toBe(
      "opensession-bill-s-mini-pc-2",
    );
    expect(roleSessionName("x".repeat(100))).toHaveLength(64);
  });
});
