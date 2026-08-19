import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import {
  AWS_HUMAN_AUTH_DENIAL,
  agentAwsCredsEnabled,
  agentAwsMintUser,
  ensureAgentAwsCredsFile,
  getAgentAwsEnv,
  isAwsHumanAuthRequest,
  mintCommand,
  type MintSpawn,
} from "./aws-creds";
import { makeAskHandler } from "./asks";

describe("AWS human-auth guard", () => {
  test("blocks AWS SSO device authorization requests", () => {
    expect(
      isAwsHumanAuthRequest(
        "AWS login",
        "Please authorize stage log access at https://d-9a67574b8b.awsapps.com/start/#/device with code XBBV-XSJV."
      )
    ).toBe(true);
    expect(
      isAwsHumanAuthRequest(
        "Please approve the AWS SSO device login and enter the code."
      )
    ).toBe(true);
    expect(
      isAwsHumanAuthRequest(
        "Open the Amazon Web Services device authorization page and sign in."
      )
    ).toBe(true);
  });

  test("does not block ordinary AWS or unrelated login questions", () => {
    expect(isAwsHumanAuthRequest("Which IAM role should stage logs use?")).toBe(false);
    expect(isAwsHumanAuthRequest("Can you review this AWS policy?")).toBe(false);
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
    "AGENT_AWS_REGION",
    "AGENT_AWS_MINT_USER",
    "AWS_REGION",
    "OPENSESSION_CONFIG",
  ];
  let saved: Record<string, string | undefined> = {};
  let dir = "";

  /** A spawn that fails the test if the mint reaches it, plus a call log. */
  const calls: string[][] = [];
  const refuse: MintSpawn = async (argv) => {
    calls.push(argv);
    throw new Error("the mint must not spawn anything when it is off");
  };

  function writeConfig(body: unknown) {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(body));
    process.env.OPENSESSION_CONFIG = path;
  }

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), "aws-creds-test-"));
    writeConfig({});
  });

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

  test("config enables it without any env var", () => {
    writeConfig({ integrations: { aws: { region: "eu-central-1" } } });
    expect(agentAwsCredsEnabled()).toBe(true);
    writeConfig({ integrations: { aws: { enabled: false, region: "eu-central-1" } } });
    expect(agentAwsCredsEnabled()).toBe(false);
  });

  test("the mint unit runs as the configured user, never a hardcoded one", () => {
    expect(agentAwsMintUser()).toBe(userInfo().username);
    writeConfig({ integrations: { aws: { mintUser: "opensession" } } });
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
});
