import { describe, expect, test } from "bun:test";
import { runnerCommandAwsEnv } from "./runner-command-aws";

const runner = {
  id: "runner-test",
  name: "Bill",
  aws: {
    roleArn: "arn:aws:iam::123456789012:role/os-runner",
    externalId: "external",
  },
};
const creds = {
  AccessKeyId: "role-key",
  SecretAccessKey: "role-secret",
  Token: "role-token",
  Region: "eu-west-1",
  Expiration: new Date(Date.now() + 3_600_000).toISOString(),
};

describe("Runner command AWS credentials", () => {
  test("projects only the configured assumed role", async () => {
    const env = await runnerCommandAwsEnv(runner, 30_000, {
      enabled: () => true,
      assume: async (role, name) => {
        expect(role).toEqual(runner.aws);
        expect(name).toBe("opensession-Bill");
        return creds;
      },
    });
    expect(env).toEqual({
      AWS_ACCESS_KEY_ID: "role-key",
      AWS_SECRET_ACCESS_KEY: "role-secret",
      AWS_SESSION_TOKEN: "role-token",
      AWS_REGION: "eu-west-1",
      AWS_DEFAULT_REGION: "eu-west-1",
    });
  });
  test("no configured role does not mint", async () => {
    expect(
      await runnerCommandAwsEnv({ ...runner, aws: undefined }, 30_000, {
        assume: async () => {
          throw new Error("must not mint");
        },
      }),
    ).toEqual({});
  });
  test("disabled mint fails closed", async () => {
    await expect(
      runnerCommandAwsEnv(runner, 30_000, {
        enabled: () => false,
        assume: async () => {
          throw new Error("must not mint");
        },
      }),
    ).rejects.toThrow("not enabled");
  });
  test("failed, expired, and too-short sessions fail closed", async () => {
    for (const value of [
      null,
      { ...creds, Expiration: "invalid" },
      { ...creds, Expiration: new Date(Date.now() - 1).toISOString() },
      { ...creds, Expiration: new Date(Date.now() + 30_000).toISOString() },
    ]) {
      await expect(
        runnerCommandAwsEnv(runner, 30_000, {
          enabled: () => true,
          assume: async () => value,
        }),
      ).rejects.toThrow("Could not obtain");
    }
  });
});
