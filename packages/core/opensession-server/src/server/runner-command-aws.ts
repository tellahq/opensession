import { audit } from "./audit";
import {
  agentAwsCredsEnabled,
  assumeRunnerRole,
  roleSessionName,
} from "./aws-creds";
import type { Runner } from "./runners";

/** Only bounded interactive commands use this projection, never workspace probes. */
export async function runnerCommandAwsEnv(
  runner: Pick<Runner, "id" | "name" | "aws">,
  timeoutMs = 10 * 60_000,
  deps: { enabled?: () => boolean; assume?: typeof assumeRunnerRole } = {},
): Promise<Record<string, string>> {
  if (!runner.aws) return {};
  if (!(deps.enabled ?? agentAwsCredsEnabled)())
    throw new Error("AWS credentials are not enabled on the Open Session host");
  const creds = await (deps.assume ?? assumeRunnerRole)(
    runner.aws,
    roleSessionName(runner.name),
  );
  const duration = Math.min(Math.max(timeoutMs, 1_000), 60 * 60_000);
  const usable =
    creds && Date.parse(creds.Expiration) > Date.now() + duration + 60_000;
  audit({
    msg: "runner_command_aws_vended",
    runner_id: runner.id,
    role_arn: runner.aws.roleArn,
    outcome: usable ? "ok" : "failed",
  });
  if (!usable)
    throw new Error(
      `Could not obtain ${runner.aws.roleArn} credentials valid for this command's timeout; retry with a shorter timeout`,
    );
  return {
    AWS_ACCESS_KEY_ID: creds.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
    AWS_SESSION_TOKEN: creds.Token,
    AWS_REGION: creds.Region,
    AWS_DEFAULT_REGION: creds.Region,
  };
}
