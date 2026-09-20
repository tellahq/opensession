/**
 * `GET /run-hosts/<hostId>/aws-credentials`: a Runner run host asks for the
 * AWS credentials its run may use.
 *
 * This is a machine route outside `/api`: the caller is a run host on
 * another machine with no person's cookie, authenticated the way its run-ws
 * dial-back is, by the per-launch wsToken registered for that hostId. Every
 * fact that decides the answer is server-owned: the Runner the host belongs
 * to and the run's `aws` grant come from the launch registration
 * (run-ws.ts), the role from the Runner record an administrator edited. The
 * host asserts nothing but its identity.
 *
 * The answer is a session for the Runner's configured IAM role, assumed by
 * this host's instance role. The instance credentials themselves are never
 * in the response. A Runner without a role gets 404 and its runs proceed
 * without AWS; a run the server withheld AWS from (automation, untrusted)
 * gets 403.
 */

import { audit } from "../audit";
import {
  agentAwsCredsEnabled,
  assumeRunnerRole,
  roleSessionName,
} from "../aws-creds";
import { runHostRequestAuthorized, runWsHostContext } from "../run-ws";
import { getRunner } from "../runners";

const ROUTE = /^\/run-hosts\/([A-Za-z0-9_.-]+)\/aws-credentials$/;

export function isRunHostAwsRoute(path: string): boolean {
  return ROUTE.test(path);
}

export async function handleRunHostAwsRoute(
  req: Request,
  path: string,
  deps: {
    assume?: typeof assumeRunnerRole;
    enabled?: () => boolean;
  } = {},
): Promise<Response> {
  const hostId = path.match(ROUTE)?.[1];
  if (!hostId) return Response.json({ error: "Not found" }, { status: 404 });
  if (req.method !== "GET")
    return Response.json({ error: "GET only" }, { status: 405 });
  if (!runHostRequestAuthorized(req, hostId))
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  const context = runWsHostContext(hostId);
  if (!context)
    return Response.json(
      { error: "This run host is not on a Runner" },
      { status: 404 },
    );
  const runner = getRunner(context.runnerId);
  if (!runner?.aws)
    return Response.json(
      { error: "No AWS role is configured for this Runner" },
      { status: 404 },
    );
  if (!context.aws)
    return Response.json(
      { error: "This run does not receive AWS credentials" },
      { status: 403 },
    );
  if (!(deps.enabled ?? agentAwsCredsEnabled)())
    return Response.json(
      { error: "AWS credentials are not enabled on the Open Session host" },
      { status: 503 },
    );
  const creds = await (deps.assume ?? assumeRunnerRole)(
    runner.aws,
    roleSessionName(runner.name),
  );
  audit({
    msg: "runner_aws_role_vended",
    runner_id: runner.id,
    host_id: hostId,
    role_arn: runner.aws.roleArn,
    outcome: creds ? "ok" : "failed",
  });
  if (!creds)
    return Response.json(
      { error: `Could not assume ${runner.aws.roleArn}` },
      { status: 503 },
    );
  return Response.json(creds, { headers: { "cache-control": "no-store" } });
}
