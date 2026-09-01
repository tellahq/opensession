/**
 * AWS Lambda MicroVM provider.
 *
 * The AWS control plane has no structured exec API, so the configured image
 * must run deploy/sandbox/lambda-microvm/control.py on port 8080. Requests to
 * that daemon use short-lived, port-scoped JWE tokens minted by AWS. Runtime
 * disk survives suspend/resume but is discarded after the hard eight-hour
 * lifetime, so this provider rotates before expiry and remains best suited to
 * sessions that push their work regularly.
 */

import type {
  GetMicrovmResponse,
  LambdaMicrovmsClient,
} from "@aws-sdk/client-lambda-microvms";
import { getRepo, worktreePathFor } from "../../worktree";
import { sandboxConfig } from "../config";
import type {
  PortMap,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  findRemoteStateBySession,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  removeRemoteState,
  resolveTrustPolicy,
  setupRemoteWorkspace,
  shellQuoteWord,
  touchRemoteState,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./bootstrap";

const DEFAULT_CONTROL_PORT = 8080;
const DEFAULT_MAX_DURATION_SECONDS = 8 * 60 * 60;
const RECREATE_BEFORE_EXPIRY_MS = 30 * 60 * 1000;
const TOKEN_TTL_MINUTES = 30;
const TOKEN_REFRESH_MS = 25 * 60 * 1000;

type AwsModule = typeof import("@aws-sdk/client-lambda-microvms");

async function awsModule(): Promise<AwsModule> {
  return import("@aws-sdk/client-lambda-microvms");
}

function awsConfig() {
  const cfg = sandboxConfig().awsLambdaMicrovm;
  if (!cfg?.imageIdentifier) {
    throw new Error(
      'lambda-microvm sandbox provider is not configured — set {"awsLambdaMicrovm":{"imageIdentifier":"arn:aws:lambda:…:microvm-image:…"}} in ~/.opensession-sandbox.json',
    );
  }
  const region =
    cfg.region ||
    process.env.AGENT_AWS_REGION ||
    process.env.AWS_REGION ||
    "us-east-1";
  return { cfg, region };
}

async function awsClient(): Promise<LambdaMicrovmsClient> {
  const { region } = awsConfig();
  const clients = ((globalThis as any).__opensessionLambdaMicrovmClients ||=
    new Map()) as Map<string, LambdaMicrovmsClient>;
  const cached = clients.get(region);
  if (cached) return cached;
  const { LambdaMicrovmsClient } = await awsModule();
  const client = new LambdaMicrovmsClient({ region });
  clients.set(region, client);
  return client;
}

function statusOf(state: string | undefined): SandboxStatus {
  if (state === "RUNNING") return "running";
  if (state === "SUSPENDED" || state === "SUSPENDING" || state === "PENDING")
    return "stopped";
  return "gone";
}

async function getMicrovm(
  client: LambdaMicrovmsClient,
  id: string,
): Promise<GetMicrovmResponse | null> {
  const { GetMicrovmCommand } = await awsModule();
  try {
    return await client.send(new GetMicrovmCommand({ microvmIdentifier: id }));
  } catch (e) {
    if ((e as { name?: string })?.name === "ResourceNotFoundException")
      return null;
    throw e;
  }
}

async function ensureRunning(
  client: LambdaMicrovmsClient,
  id: string,
): Promise<GetMicrovmResponse> {
  const { ResumeMicrovmCommand } = await awsModule();
  let info = await getMicrovm(client, id);
  if (!info) throw new Error(`Lambda MicroVM ${id} is gone`);
  let resumeSent = false;
  const deadline = Date.now() + 5 * 60_000;
  while (info.state !== "RUNNING" && Date.now() < deadline) {
    if (statusOf(info.state) === "gone") {
      throw new Error(
        `Lambda MicroVM ${id} terminated: ${info.stateReason || info.state}`,
      );
    }
    if (info.state === "SUSPENDED" && !resumeSent) {
      await client.send(new ResumeMicrovmCommand({ microvmIdentifier: id }));
      resumeSent = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    info = await getMicrovm(client, id);
    if (!info) throw new Error(`Lambda MicroVM ${id} is gone`);
  }
  if (info.state !== "RUNNING")
    throw new Error(`Lambda MicroVM ${id} did not become ready`);
  return info;
}

function lambdaDriver(
  client: LambdaMicrovmsClient,
  id: string,
  initialEndpoint?: string,
): RemoteDriver {
  let endpoint = initialEndpoint;
  let token = "";
  let tokenAt = 0;

  const auth = async () => {
    if (token && Date.now() - tokenAt < TOKEN_REFRESH_MS) return token;
    const { cfg } = awsConfig();
    const { CreateMicrovmAuthTokenCommand } = await awsModule();
    const response = await client.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: id,
        expirationInMinutes: TOKEN_TTL_MINUTES,
        allowedPorts: [{ port: cfg.controlPort || DEFAULT_CONTROL_PORT }],
      }),
    );
    token = response.authToken?.["X-aws-proxy-auth"] || "";
    if (!token) throw new Error(`Lambda MicroVM ${id} returned no auth token`);
    tokenAt = Date.now();
    return token;
  };

  const request = async (path: string, body: unknown) => {
    if (!endpoint) endpoint = (await ensureRunning(client, id)).endpoint;
    if (!endpoint) throw new Error(`Lambda MicroVM ${id} returned no endpoint`);
    const { cfg } = awsConfig();
    const base = /^https?:\/\//.test(endpoint)
      ? endpoint
      : `https://${endpoint}`;
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-aws-proxy-auth": await auth(),
        "X-aws-proxy-port": String(cfg.controlPort || DEFAULT_CONTROL_PORT),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(16 * 60_000),
    });
    if (!response.ok) {
      throw new Error(
        `Lambda MicroVM ${path} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
    }
    return response;
  };

  return {
    async exec(cmd: string, opts?: RemoteExecOpts) {
      try {
        const response = await request("/exec", {
          command: cmd,
          cwd: opts?.cwd,
          env: opts?.env,
          timeoutMs: opts?.timeoutMs ?? 120_000,
        });
        const result = (await response.json()) as {
          exitCode?: number;
          stdout?: string;
          stderr?: string;
        };
        return {
          exitCode: Number(result.exitCode ?? 1),
          stdout: result.stdout || "",
          stderr: result.stderr || "",
        };
      } catch (e: any) {
        return { exitCode: 1, stdout: "", stderr: String(e?.message || e) };
      }
    },
    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      await request("/background", {
        command: cmd,
        cwd: opts?.cwd,
        env: opts?.env,
      });
    },
    async writeFile(path: string, content: string) {
      await request("/files", {
        path,
        content: Buffer.from(content, "utf-8").toString("base64"),
      });
    },
    async ensureStarted() {
      const info = await ensureRunning(client, id);
      endpoint = info.endpoint;
    },
  };
}

export class LambdaMicrovmProvider implements SandboxProvider {
  readonly id = "lambda-microvm" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    if (spec.attachedDirs?.length) {
      throw new Error(
        "attached repos are not supported in remote sandboxes — detach them or use docker/local",
      );
    }
    const { cfg, region } = awsConfig();
    const client = await awsClient();
    let prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const trust = resolveTrustPolicy(spec, prevState);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd =
      spec.cwd ||
      prevState?.cwd ||
      worktreePathFor(branch, repo.id, { isolated: true });

    const pendingClientToken = prevState?.pendingClientToken;
    let info =
      prevState && !pendingClientToken
        ? await getMicrovm(client, prevState.sandboxId)
        : null;
    const configuredDuration = Math.max(
      3600,
      Math.min(
        DEFAULT_MAX_DURATION_SECONDS,
        cfg.maximumDurationSeconds || DEFAULT_MAX_DURATION_SECONDS,
      ),
    );
    const rolloverMarginMs = Math.min(
      RECREATE_BEFORE_EXPIRY_MS,
      configuredDuration * 1000 * 0.1,
    );
    if (
      info?.startedAt &&
      Date.now() - info.startedAt.getTime() >=
        (info.maximumDurationInSeconds || DEFAULT_MAX_DURATION_SECONDS) * 1000 -
          rolloverMarginMs
    ) {
      const oldDriver = lambdaDriver(
        client,
        prevState!.sandboxId,
        info.endpoint,
      );
      await oldDriver.ensureStarted();
      const pending = await oldDriver.exec(
        `cd ${shellQuoteWord(cwd)} && ` +
          `git rev-parse --verify '@{upstream}' >/dev/null 2>&1 && ` +
          `test -z "$(git status --porcelain)" && ` +
          `test -z "$(git log --format=%H '@{upstream}..HEAD')"`,
      );
      if (pending.exitCode !== 0) {
        throw new Error(
          "Lambda MicroVM is nearing its hard lifetime without a clean, fully pushed upstream branch; commit and push before it can rotate",
        );
      }
      await this.terminate(client, prevState!.sandboxId);
      removeRemoteState(this.id, prevState!.sandboxId);
      prevState = null;
      info = null;
    }

    let created = false;
    if (!info || statusOf(info.state) === "gone") {
      if (prevState && !pendingClientToken) {
        removeRemoteState(this.id, prevState.sandboxId);
        prevState = null;
      }
      const { RunMicrovmCommand } = await awsModule();
      const clientToken = pendingClientToken || crypto.randomUUID();
      if (!pendingClientToken) {
        writeRemoteState({
          sandboxId: `pending-${clientToken}`,
          pendingClientToken: clientToken,
          provider: this.id,
          sessionId: spec.sessionId,
          cwd,
          repoId: repo.id,
          branch,
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          ...trust,
        });
      }
      const response = await client.send(
        new RunMicrovmCommand({
          imageIdentifier: cfg.imageIdentifier,
          imageVersion: cfg.imageVersion,
          executionRoleArn: cfg.executionRoleArn,
          ingressNetworkConnectors: [
            cfg.ingressConnectorArn ||
              `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
          ],
          egressNetworkConnectors: [
            cfg.egressConnectorArn ||
              `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
          ],
          // Agent runs communicate over an outbound WebSocket, which AWS does
          // not count as endpoint activity. Automatic idle suspension would
          // therefore freeze a healthy long turn, so it is opt-in only.
          ...(cfg.idleSuspendSeconds
            ? {
                idlePolicy: {
                  autoResumeEnabled: true,
                  maxIdleDurationSeconds: cfg.idleSuspendSeconds,
                  suspendedDurationSeconds: Math.max(
                    60,
                    cfg.suspendedDurationSeconds || 3600,
                  ),
                },
              }
            : {}),
          maximumDurationInSeconds: configuredDuration,
          runHookPayload: JSON.stringify({ sessionId: spec.sessionId }),
          clientToken,
          ...(cfg.logGroup
            ? { logging: { cloudWatch: { logGroup: cfg.logGroup } } }
            : {}),
        }),
      );
      if (!response.microvmId)
        throw new Error("RunMicrovm returned no microvmId");
      removeRemoteState(this.id, `pending-${clientToken}`);
      info = response;
      created = true;
      // Persist immediately so a crash during bootstrap cannot orphan paid compute.
      writeRemoteState({
        sandboxId: response.microvmId,
        provider: this.id,
        sessionId: spec.sessionId,
        cwd,
        repoId: repo.id,
        branch,
        createdAt:
          response.startedAt?.toISOString() || new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        ...trust,
      });
    }

    const id = info.microvmId!;
    const driver = lambdaDriver(client, id, info.endpoint);
    try {
      await driver.ensureStarted();
      await assertDialbackReachable(driver, "lambda-microvm");
      await bootstrapRemoteSandbox(driver, "lambda-microvm");
      await setupRemoteWorkspace(
        driver,
        cwd,
        await remoteCloneUrl(repo),
        branch,
        repo.defaultBranch,
        repo.id,
        {
          sandboxId: id,
          provider: this.id,
          sessionId: spec.sessionId,
          repoId: repo.id,
          trustProfile: trust.trustProfile,
        },
      );
    } catch (e) {
      if (created) await this.terminate(client, id).catch(() => {});
      throw e;
    }
    writeRemoteState({
      sandboxId: id,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: info.startedAt?.toISOString() || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    });
    return this.makeHandle(client, info, spec.sessionId, cwd);
  }

  private makeHandle(
    client: LambdaMicrovmsClient,
    info: GetMicrovmResponse,
    sessionId: string,
    cwd: string,
  ): Sandbox {
    const id = info.microvmId!;
    return makeRemoteSandbox({
      providerId: this.id,
      sandboxId: id,
      sessionId,
      cwd,
      driver: lambdaDriver(client, id, info.endpoint),
      async ports(): Promise<PortMap> {
        // AWS endpoint requests require expiring auth headers. A browser-safe
        // reverse proxy is required before these can become direct preview URLs.
        return {};
      },
      async status(): Promise<SandboxStatus> {
        try {
          return statusOf((await getMicrovm(client, id))?.state);
        } catch {
          return "gone";
        }
      },
      touchActivity: () => touchRemoteState(this.id, id),
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    try {
      const client = await awsClient();
      const info = await getMicrovm(client, sandboxId);
      if (!info || statusOf(info.state) === "gone") return null;
      return this.makeHandle(client, info, state.sessionId, state.cwd);
    } catch (e) {
      console.warn(`[sandbox:lambda-microvm] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  private async terminate(
    client: LambdaMicrovmsClient,
    sandboxId: string,
  ): Promise<void> {
    const { TerminateMicrovmCommand } = await awsModule();
    await client.send(
      new TerminateMicrovmCommand({ microvmIdentifier: sandboxId }),
    );
  }

  async destroy(sandboxId: string): Promise<void> {
    try {
      await this.terminate(await awsClient(), sandboxId);
    } catch (e) {
      if ((e as { name?: string })?.name !== "ResourceNotFoundException") {
        console.warn(`[sandbox:lambda-microvm] destroy(${sandboxId}):`, e);
        throw e;
      }
    }
    removeRemoteState(this.id, sandboxId);
  }
}
