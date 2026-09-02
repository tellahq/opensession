/** Interactive session Portal MCP. Portals expose only processes in this session workspace. */

import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import {
  getPreviewStatus,
  getSandboxPreviewStatus,
  recipeStartOptions,
  sandboxPreviewIdentityContext,
} from "./preview";
import {
  listPortalServices,
  listSandboxPortalServices,
  restartPortalService,
  restartSandboxPortalService,
  normalizePortalPath,
  setPortalPath,
  setSandboxPortalPath,
  startPortalService,
  startSandboxPortalService,
  stopPortalService,
  stopSandboxPortalService,
} from "./portal-supervisor";
import {
  listRunnerPortalServices,
  restartRunnerPortal,
  runnerPortalUrl,
  setRunnerPortalPath,
  startRunnerPortal,
  stopRunnerPortal,
} from "./runner-portals";
import type { UnifiedSession } from "./types";
import type { Sandbox } from "./sandbox/provider";
import { createWorkloadIdentityEnv } from "./workload-identity";
import { getRepo } from "./worktree";

const verifiedEditorFixtureSchema = z.object({
  leaseId: z.string().regex(/^epfl_[A-Za-z0-9]+$/),
  videoId: z.string().regex(/^vid_[A-Za-z0-9]+$/),
  editorPath: z.string(),
  expiresAt: z.string().datetime(),
  editorAccessVerified: z.literal(true),
});

type VerifiedEditorFixture = z.infer<typeof verifiedEditorFixtureSchema>;

export interface PortalsMcpContext {
  sessionId: string;
  worktreeDir: () => string | undefined;
  verifyEditorFixture: (leaseId: string) => Promise<VerifiedEditorFixture>;
  setDefaultPath: (
    path: string | null,
    options?: {
      exclusiveKey?: string;
      sourceLeaseId?: string;
      leaseMinutes?: number;
    },
  ) => Promise<{ leaseId?: string }>;
  /** An explicit computation action may wake the Sandbox. Passive listing may not. */
  sandbox: (options?: { wake?: boolean }) => Promise<Sandbox | null>;
  hasSandbox: () => boolean;
  /** Runner sessions own their services on the trusted remote machine. */
  runner: () => UnifiedSession | undefined;
}

function result(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}
function workspace(ctx: PortalsMcpContext): string | Error {
  const dir = ctx.worktreeDir();
  return dir ? dir : new Error("This session has no workspace for a Portal.");
}

async function portalStatus(
  ctx: PortalsMcpContext,
  dir: string,
  sandbox: Sandbox | null,
) {
  return sandbox
    ? getSandboxPreviewStatus(sandbox, dir, ctx.sessionId)
    : getPreviewStatus(dir);
}

function sandboxPortalEnv(
  ctx: PortalsMcpContext,
  sandbox: Sandbox,
): Record<string, string> {
  const session = ctx.runner();
  if (!session?.repo) return {};
  return createWorkloadIdentityEnv(
    sandboxPreviewIdentityContext(
      sandbox,
      getRepo(session.repo).id,
      "interactive",
    ),
  );
}

type PortalStartInput = {
  name: string;
  command: string;
  port?: number;
  key?: string;
  description?: string;
  readyTimeoutMs?: number;
};

async function startPortalForContext(
  ctx: PortalsMcpContext,
  dir: string,
  sandbox: Sandbox | null,
  input: PortalStartInput,
): Promise<string> {
  const session = ctx.runner();
  if (session?.runner) {
    const portal = await startRunnerPortal({
      session,
      name: input.name,
      command: input.command,
      ...(input.port ? { port: input.port } : {}),
      ...(input.description ? { description: input.description } : {}),
    });
    return `${portal.name} is ready at ${(await runnerPortalUrl(portal)) ?? "its authenticated Portal URL"}.`;
  }
  const portal = sandbox
    ? await startSandboxPortalService({
        sessionId: ctx.sessionId,
        sandbox,
        ...input,
        env: sandboxPortalEnv(ctx, sandbox),
      })
    : await startPortalService({
        sessionId: ctx.sessionId,
        worktreeDir: dir,
        ...input,
      });
  const status = await portalStatus(ctx, dir, sandbox);
  const service = status.services.find(
    (candidate) => candidate.key === portal.key,
  );
  return `${portal.name} is ready at ${service?.previewUrl ?? "its authenticated Portal URL"}.`;
}

function isTellaEditorPath(path: string): boolean {
  const normalized = normalizePortalPath(path);
  if (!normalized) return false;
  const pathname = new URL(normalized, "https://preview.invalid").pathname;
  return /^\/video\/[^/]+\/edit(?:\/|$)/.test(pathname);
}

export function createPortalsMcpServer(ctx: PortalsMcpContext) {
  return createSdkMcpServer({
    name: "opensession-portals",
    version: "1.0.0",
    tools: [
      tool(
        "start_portal",
        "Start a supervised HTTP or WebSocket service in this session workspace. Open Session allocates a port when omitted, sets PORT and PORTAL_URL, waits for it to listen, and returns its authenticated Portal URL. Never use an upstream URL: Portals expose only this session's process.",
        {
          name: z.string(),
          command: z.string(),
          port: z.number().int().optional(),
          description: z.string().optional(),
        },
        async (args: {
          name: string;
          command: string;
          port?: number;
          description?: string;
        }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            const runner = ctx.runner();
            const sandbox = runner?.runner
              ? null
              : await ctx.sandbox({ wake: true });
            if (!sandbox && !runner?.runner && ctx.hasSandbox())
              return result(
                "Could not start Portal: this session's Sandbox is unavailable.",
              );
            const status = await portalStatus(ctx, dir, sandbox);
            const recipe = status.portalRecipes.find(
              (candidate) => candidate.id === args.name,
            );
            return result(
              await startPortalForContext(
                ctx,
                dir,
                sandbox,
                recipe ? recipeStartOptions(recipe) : args,
              ),
            );
          } catch (error) {
            return result(
              `Could not start Portal: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "start_declared_portal",
        "Start a repository-declared Portal by its ID. Use this instead of copying its command: Open Session applies the trusted command, port contract, readiness timeout, and sandbox workload identity from .agents/portals.json.",
        {
          id: z.string(),
        },
        async ({ id }: { id: string }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            const runner = ctx.runner();
            const sandbox = runner?.runner
              ? null
              : await ctx.sandbox({ wake: true });
            if (!sandbox && !runner?.runner && ctx.hasSandbox())
              return result(
                "Could not start Portal: this session's Sandbox is unavailable.",
              );
            const status = await portalStatus(ctx, dir, sandbox);
            const recipe = status.portalRecipes.find(
              (candidate) => candidate.id === id,
            );
            if (!recipe)
              return result(
                `Could not start Portal: declared Portal '${id}' was not found.`,
              );
            return result(
              await startPortalForContext(
                ctx,
                dir,
                sandbox,
                recipeStartOptions(recipe),
              ),
            );
          } catch (error) {
            return result(
              `Could not start Portal: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "list_portals",
        "List this session's registered Portals and their readiness. Use this after starting a service before telling the user it is ready.",
        {},
        async () => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          const runner = ctx.runner();
          if (runner?.runner) {
            const portals = await listRunnerPortalServices(runner);
            if (!portals.length)
              return result(
                "No Portals are registered. Use start_portal for a live app or service.",
              );
            return result(
              (
                await Promise.all(
                  portals.map(
                    async (portal) =>
                      `${portal.name}\nstate: ${portal.state}\nport: ${portal.port}\nurl: ${(await runnerPortalUrl(portal)) ?? "not ready"}${portal.description ? `\ndescription: ${portal.description}` : ""}`,
                  ),
                )
              ).join("\n\n"),
            );
          }
          const sandbox = await ctx.sandbox();
          if (!sandbox && ctx.hasSandbox())
            return result(
              "This session's Sandbox is sleeping or unavailable. Opening a Portal or sending a message wakes it.",
            );
          const portals = sandbox
            ? await listSandboxPortalServices(sandbox)
            : await listPortalServices(dir);
          if (!portals.length)
            return result(
              "No Portals are registered. Use start_portal for a live app or service.",
            );
          const status = await portalStatus(ctx, dir, sandbox);
          return result(
            portals
              .map((portal) => {
                const service = status.services.find(
                  (candidate) => candidate.key === portal.key,
                );
                return `${portal.name}\nstate: ${portal.state}\nport: ${portal.port}\nurl: ${service?.previewUrl ?? "not ready"}${portal.description ? `\ndescription: ${portal.description}` : ""}`;
              })
              .join("\n\n"),
          );
        },
      ),
      tool(
        "stop_portal",
        "Stop one supervised Portal in this session. It never affects services in another session.",
        { name: z.string() },
        async ({ name }: { name: string }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            const runner = ctx.runner();
            if (runner?.runner) {
              await stopRunnerPortal({ session: runner, name });
              return result(`Stopped ${name}.`);
            }
            const sandbox = await ctx.sandbox();
            if (!sandbox && ctx.hasSandbox())
              return result(
                "Could not stop Portal: this session's Sandbox is sleeping or unavailable.",
              );
            if (sandbox)
              await stopSandboxPortalService({
                sessionId: ctx.sessionId,
                sandbox,
                name,
              });
            else
              await stopPortalService({
                sessionId: ctx.sessionId,
                worktreeDir: dir,
                name,
              });
            return result(`Stopped ${name}.`);
          } catch (error) {
            return result(`Could not stop Portal: ${(error as Error).message}`);
          }
        },
      ),
      tool(
        "restart_portal",
        "Restart one supervised Portal using its registered command and port. Repository-declared Portals are refreshed from their trusted recipe before restart.",
        { name: z.string() },
        async ({ name }: { name: string }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            const runner = ctx.runner();
            const sandbox = runner?.runner
              ? null
              : await ctx.sandbox({ wake: true });
            if (!sandbox && !runner?.runner && ctx.hasSandbox())
              return result(
                "Could not restart Portal: this session's Sandbox is unavailable.",
              );
            const status = await portalStatus(ctx, dir, sandbox);
            const recipe = status.portalRecipes.find(
              (candidate) => candidate.id === name,
            );
            if (recipe) {
              const options = recipeStartOptions(recipe);
              if (sandbox) {
                const portal = await restartSandboxPortalService({
                  sessionId: ctx.sessionId,
                  sandbox,
                  ...options,
                  env: sandboxPortalEnv(ctx, sandbox),
                });
                const refreshed = await portalStatus(ctx, dir, sandbox);
                return result(
                  `${portal.name} restarted at ${refreshed.services.find((candidate) => candidate.key === portal.key)?.previewUrl ?? "its authenticated Portal URL"}.`,
                );
              }
              if (runner?.runner)
                await stopRunnerPortal({ session: runner, name });
              else
                await stopPortalService({
                  sessionId: ctx.sessionId,
                  worktreeDir: dir,
                  name,
                });
              return result(
                await startPortalForContext(ctx, dir, sandbox, options),
              );
            }
            if (runner?.runner) {
              const portal = await restartRunnerPortal({
                session: runner,
                name,
              });
              return result(
                `${portal.name} restarted at ${(await runnerPortalUrl(portal)) ?? "its authenticated Portal URL"}.`,
              );
            }
            const portal = sandbox
              ? await restartSandboxPortalService({
                  sessionId: ctx.sessionId,
                  sandbox,
                  name,
                  env: sandboxPortalEnv(ctx, sandbox),
                })
              : await restartPortalService({
                  sessionId: ctx.sessionId,
                  worktreeDir: dir,
                  name,
                });
            const refreshed = await portalStatus(ctx, dir, sandbox);
            return result(
              `${portal.name} restarted at ${refreshed.services.find((candidate) => candidate.key === portal.key)?.previewUrl ?? "its authenticated Portal URL"}.`,
            );
          } catch (error) {
            return result(
              `Could not restart Portal: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "set_editor_preview_path",
        "Verify a Tella editor fixture lease server-side, then set and exclusively reserve its authoritative editor route. Invented, expired, mismatched, or inaccessible fixtures are rejected.",
        {
          fixtureLeaseId: z.string().regex(/^epfl_[A-Za-z0-9]+$/),
        },
        async ({ fixtureLeaseId }: { fixtureLeaseId: string }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            const fixture = verifiedEditorFixtureSchema.parse(
              await ctx.verifyEditorFixture(fixtureLeaseId),
            );
            if (fixture.leaseId !== fixtureLeaseId)
              throw new Error("Tella returned a different fixture lease.");
            const normalized = normalizePortalPath(fixture.editorPath);
            if (!normalized)
              throw new Error("Tella returned an empty editor staging route.");
            const pathname = new URL(normalized, "https://preview.invalid")
              .pathname;
            if (pathname !== `/video/${fixture.videoId}/edit`)
              throw new Error(
                "Tella's leased video ID does not match its editor route.",
              );
            const remainingMinutes = Math.floor(
              (Date.parse(fixture.expiresAt) - Date.now()) / 60_000,
            );
            if (remainingMinutes < 10 || remainingMinutes > 7 * 24 * 60)
              throw new Error(
                "Tella's editor fixture lease must have between 10 minutes and 7 days remaining.",
              );
            const reservation = await ctx.setDefaultPath(normalized, {
              exclusiveKey: `video:${fixture.videoId}`,
              sourceLeaseId: fixture.leaseId,
              leaseMinutes: remainingMinutes,
            });
            if (!reservation.leaseId)
              throw new Error("The staging record could not be reserved.");
            return result(
              `Verified and reserved Tella fixture ${fixture.leaseId} at ${normalized} for this session.`,
            );
          } catch (error) {
            return result(
              `Could not set editor preview path: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "set_portal_path",
        "Set the root-relative route a Portal should open by default. Omit name to set the session's default testing route.",
        { name: z.string().optional(), path: z.string() },
        async ({ name, path }: { name?: string; path: string }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            if (isTellaEditorPath(path))
              throw new Error(
                "Tella editor routes require set_editor_preview_path with a verified fixture lease.",
              );
            if (name) {
              const runner = ctx.runner();
              if (runner?.runner) {
                await setRunnerPortalPath({ session: runner, name, path });
                return result(`Set ${name}'s default route to ${path || "/"}.`);
              }
              const sandbox = await ctx.sandbox();
              if (!sandbox && ctx.hasSandbox())
                return result(
                  "Could not set Portal route: this session's Sandbox is sleeping or unavailable.",
                );
              if (sandbox) await setSandboxPortalPath(sandbox, path, name);
              else setPortalPath(dir, path, name);
            } else {
              const normalized = normalizePortalPath(path) ?? null;
              await ctx.setDefaultPath(normalized);
              return result(
                `Set this session's default route to ${normalized || "/"}.`,
              );
            }
            return result(`Set ${name}'s default route to ${path || "/"}.`);
          } catch (error) {
            return result(
              `Could not set Portal path: ${(error as Error).message}`,
            );
          }
        },
      ),
    ],
  });
}
