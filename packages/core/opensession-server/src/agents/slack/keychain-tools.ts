/**
 * opensession-keychain — borrow a teammate's credential for a stated purpose.
 *
 * No tool returns a secret value: list what exists, ask an owner
 * for a scoped grant, list this session's grants. Approved calls go through
 * call_credential (keychain-broker.ts), which injects the credential
 * server-side and is bound to this session, so the model never holds the
 * secret and a grant id is useless outside the session it was issued to.
 * Mac requests instead resolve one Keychain item locally and return status only.
 *
 * Bulk work goes through a scripted run instead (keychain-runs.ts): the owner
 * approves one command, and run_with_credential starts that
 * process with a proxy URL that works only while it runs. A run may use
 * several credentials; it starts once every one's owner approved, and gets
 * one proxy URL per credential.
 *
 * Interactive runs ONLY — same boundary as opensession-humans. An ask is a DM
 * to a teammate carrying a model-authored "purpose" string; letting untrusted
 * ticket text reach it would turn the agent into a social-engineering proxy
 * against our own team ("I need the Stripe key to process this refund").
 *
 * A secret pasted into a session prompt is a secret in the transcript, so
 * register_credential never takes one: the agent names the service and host,
 * the session's driver pastes the secret into a card that posts over HTTP
 * (credential-registrations.ts), and the tool gets metadata back.
 *
 * A login (a test account's username and password for a sign-in page) is the
 * one secret an agent does get, because it must type it into the page. Its
 * owner approves each release, and use_login writes the password to a
 * short-lived file in the session's workspace (keychain-logins.ts) rather
 * than returning it, so it stays out of the transcript.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
  githubLoginFor,
  resolveTeammate,
} from "../../server/shared/user-mappings";
import { findSession } from "../../server/session-cache";
import type { UnifiedSession } from "../../server/types";
import { requestCredentialRegistration } from "../../server/credential-registrations";
import {
  macKeychainRequestSchema,
  macKeychainRequests,
} from "../../server/mac-keychain-requests";
import { BROKER_METHODS, brokerCall } from "../../server/keychain-broker";
import {
  cancelCredentialAsk,
  ensureKeychainLoaded,
  listCredentials,
  listGrants,
  listKeychainAsks,
  MAX_RUN_COMMAND_CHARS,
  claimLoginRelease,
  requestCredential,
  requestCredentialRun,
  runGroupAnswer,
  MAX_RUN_CREDENTIALS,
} from "../../server/keychain";
import {
  writeReleasedLogin,
  type LoginReleaseTarget,
} from "../../server/keychain-logins";
import { workspaceExecFor } from "../../server/sandbox/workspace-exec";
import {
  credentialRunStatus,
  DEFAULT_RUN_MINUTES,
  listCredentialRuns,
  MAX_RUN_MINUTES,
  startCredentialRun,
  stopCredentialRun,
} from "../../server/keychain-runs";
import {
  scriptEnv,
  scriptLogDir,
  scriptWorkspace,
} from "../../server/script-workspace";

export interface KeychainToolContext {
  sessionId: string;
  /** Who is driving — recorded on the ask so the owner sees who is asking. */
  user: string;
  /** Test seam; defaults to the session cache. */
  session?: (
    sessionId: string,
  ) =>
    | (Pick<
        UnifiedSession,
        "automation" | "automationId" | "automationDescendantPolicy"
      > &
        Partial<Pick<UnifiedSession, "worktreeDir" | "sandbox" | "runner">>)
    | undefined;
  /** Test seam: where use_login writes. Defaults to the session's workspace. */
  loginTarget?: () => Promise<LoginReleaseTarget | { error: string }>;
}

/** Where a released password must land for the agent's shell to read it. */
async function loginTarget(
  ctx: KeychainToolContext,
): Promise<LoginReleaseTarget | { error: string }> {
  if (ctx.loginTarget) return ctx.loginTarget();
  const session = findSession(ctx.sessionId);
  if (!session) return { error: "this session isn't loaded" };
  if (session.runner)
    return {
      error:
        "this session's workspace is on a Runner, which can't receive a login",
    };
  if (!session.sandbox?.provider || !session.sandbox.sandboxId)
    return { kind: "host" };
  const exec = await workspaceExecFor(session);
  if (!exec.sandboxed)
    return exec.remote
      ? { error: "this session's Sandbox is unavailable right now" }
      : { kind: "host" };
  return { kind: "sandbox", provider: session.sandbox.provider, exec };
}

/** Where a scripted run may start, or why it can't. Its script host runs
 *  on this server, so the workspace must be here too. */
function runWorkspace(
  ctx: KeychainToolContext,
  cwd: string | undefined,
): { cwd: string } | { error: string } {
  const where = scriptWorkspace(ctx.sessionId, cwd, ctx.session ?? findSession);
  return "error" in where && /Sandbox or on a Runner/.test(where.error)
    ? { error: `${where.error}. Use call_credential instead` }
    : where;
}

/**
 * Why this run cannot register a credential, or null when it can. The
 * keychain server is already withheld from automation runs; this is the
 * second, explicit check so a misrouted automation gets a clear refusal
 * rather than a card nobody is watching.
 */
function registrationRefusal(ctx: KeychainToolContext): string | null {
  const session = (ctx.session ?? findSession)(ctx.sessionId);
  if (
    session?.automation ||
    session?.automationId ||
    session?.automationDescendantPolicy
  )
    return "Credentials can't be registered from an automation run. Ask a teammate to add it in Settings → Account.";
  if (!githubLoginFor(ctx.user) || !resolveTeammate(ctx.user))
    return "Only a signed-in teammate driving this session can register a credential. Ask them to add it in Settings → Account.";
  return null;
}

function kcAsksStillPending(ids: string[]): string[] {
  const pending = new Set(
    listKeychainAsks()
      .filter((a) => a.status === "pending")
      .map((a) => a.id),
  );
  return ids.filter((id) => pending.has(id));
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createKeychainMcpServer(ctx: KeychainToolContext) {
  /** request_credential for one scripted run with several credentials:
   *  waits on every owner's message at once. */
  const requestRun = async (
    credentials: string[],
    purpose: string,
    run: { command: string },
    extra: any,
  ) => {
    const result = requestCredentialRun({
      credentials,
      sessionId: ctx.sessionId,
      requestedBy: ctx.user,
      purpose,
      run,
    });
    if ("error" in result) return text(`Couldn't ask: ${result.error}`);
    if ("grants" in result)
      return text(
        `This session already holds this run's approvals.\n\n${result.instructions}`,
      );
    const { awaitBlockingAnswer, remindAsk } =
      await import("../../server/human-asks");
    const waits = result.transports.map((t) =>
      awaitBlockingAnswer(t.id, extra?.signal),
    );
    if (result.resurfaced)
      await Promise.all(result.transports.map((t) => remindAsk(t.id)));
    await Promise.all(waits);
    const state = runGroupAnswer(ctx.sessionId, result.asks[0]!.run!.group!.id);
    const open = kcAsksStillPending(result.asks.map((a) => a.id));
    return text(
      open.length
        ? `${state}\nThe open asks (${open.join(", ")}) stay open; call request_credential again with the same arguments to remind the owners, or cancel_credential_ask to withdraw the run.`
        : state,
    );
  };

  const tools = [
    tool(
      "request_mac_keychain",
      "Request ONE generic-password item from the prompting teammate's macOS Keychain for ONE exact HTTPS API call. Supply the item's exact service and account identifiers, never its value. This uses Apple's Keychain access prompt, not 1Password and not a vault-wide grant. No listing, shell commands, ACL changes, or raw secret export. The human opens this session in the Mac app, chooses OS → Keychain requests…, inspects the destination and selects Use once. macOS controls whether access needs Allow / Always Allow / Deny; recommend Allow, never Always Allow. Existing item permissions may allow access without another prompt. Requests expire after 10 minutes and can execute only once. Only HTTP status returns; no response data, headers or secret values enter model context. Do not use a model-provider endpoint as the destination. After a decline/failure do not retry without the human's go-ahead.",
      macKeychainRequestSchema.shape,
      async (args) => {
        const login = githubLoginFor(ctx.user);
        if (!login)
          return text("A verified teammate with a GitHub login is required.");
        const parsed = macKeychainRequestSchema.safeParse(args);
        if (!parsed.success)
          return text(
            "Invalid request: provide one Keychain service, account, purpose and exact HTTPS request (body at most 512 characters). Never supply the secret itself.",
          );
        try {
          const request = macKeychainRequests.request(
            ctx.sessionId,
            login,
            parsed.data,
          );
          return text(
            JSON.stringify({
              ...request,
              next: "Ask the human to open this session in the Mac app and choose OS → Keychain requests…. Check mac_keychain_request_status after they finish.",
            }),
          );
        } catch {
          return text(
            "Couldn't create the request. This session may already have a pending request, or the queue is full. Check its status before asking again.",
          );
        }
      },
    ),
    tool(
      "mac_keychain_request_status",
      "Check this session's macOS Keychain request. Returns only pending/claimed/completed/declined/failed and an HTTP status when completed. No secrets, response bodies, headers or helper errors are available. Missing requests expired or were revoked by a server restart.",
      { requestId: z.string().uuid() },
      async ({ requestId }) => {
        const login = githubLoginFor(ctx.user);
        return text(
          JSON.stringify(
            login
              ? macKeychainRequests.status(requestId, ctx.sessionId, login)
              : null,
          ),
        );
      },
    ),
    tool(
      "list_credentials",
      "List the credentials teammates have registered in the keychain — service, owner, target host, and any method/path limits. Secrets are never included. Use this to find out whether the access you need already exists before asking anyone for a token.",
      {},
      async () => {
        const creds = listCredentials();
        if (!creds.length) {
          return text(
            "The keychain is empty. Credentials are added by their owner in Settings → Account, or with register_credential, where the person driving this session pastes the secret into a card. Never paste a secret into a session.",
          );
        }
        const lines = creds.map((c) => {
          const limits = [
            c.allowedMethods?.length
              ? `methods ${c.allowedMethods.join("/")}`
              : null,
            c.allowedPathPrefixes?.length
              ? `paths ${c.allowedPathPrefixes.join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join("; ");
          if (c.kind === "login")
            return (
              `- **${c.service}** (login: ${c.username} on ${c.loginUrl}) — owner ${c.owner}` +
              (c.description ? `: ${c.description}` : "")
            );
          return (
            `- **${c.service}** (${c.host}) — owner ${c.owner}` +
            (c.description ? `: ${c.description}` : "") +
            (limits ? ` [${limits}]` : "")
          );
        });
        return text(`Credentials in the keychain:\n${lines.join("\n")}`);
      },
    ),
    tool(
      "request_credential",
      "Ask a credential's owner to lend it to THIS session for a stated purpose. They get a DM with Approve once / Approve standing / Decline, and this call blocks until they answer. On approval you receive instructions for call_credential, which injects the credential server-side; you never see the secret itself. For a login (a username and password for a sign-in page), the owner instead chooses Release password or Decline, and on approval you use use_login to get the password into this session's workspace." +
        " Ask only when you actually need the access now, state the real purpose (the owner is approving that sentence, and every call is audited against it), and prefer 'once' unless the task genuinely needs repeated calls. For bulk work by a script (hundreds or more calls), pass `run` instead: the owner approves that exact command, and you start it with run_with_credential. A script that needs several APIs in one process names them all in `credentials` with `run`: each credential's owner approves, and the run starts only once all of them did. If they decline, don't re-ask. Calling again with the same purpose while your ask is pending reminds the owner and waits on that same ask; if they already approved it, you get the live grant back.",
      {
        credential: z
          .string()
          .optional()
          .describe(
            "Service slug (from list_credentials) or a credential id. Give this or `credentials`.",
          ),
        credentials: z
          .array(z.string())
          .min(1)
          .max(MAX_RUN_CREDENTIALS)
          .optional()
          .describe(
            "Only with `run`: every credential one script needs, e.g. ['payments-prod', 'billing-prod']. Each owner is asked once, sees every credential in the run, and the run starts only once all of them approved.",
          ),
        purpose: z
          .string()
          .describe(
            "What you need it for, one specific sentence the owner can judge — e.g. 'read the project's latest deployment status to diagnose the failing preview'.",
          ),
        mode: z
          .enum(["once", "standing"])
          .optional()
          .describe(
            "'once' (default) = a single broker call, expires in an hour. 'standing' = repeated calls for up to 7 days; the owner can approve either regardless of what you request. Ignored with `run`.",
          ),
        run: z
          .object({
            command: z
              .string()
              .min(1)
              .max(MAX_RUN_COMMAND_CHARS)
              .describe(
                "The exact shell command run_with_credential will start, e.g. 'bun scripts/sync.ts --base \"$KEYCHAIN_PROXY_URL\"'. With one credential it reads the API base URL from KEYCHAIN_PROXY_URL; with several, from KEYCHAIN_PROXY_URL_<SLUG> for each (the slug upper-cased, other characters as _, e.g. KEYCHAIN_PROXY_URL_PAYMENTS_PROD).",
              ),
          })
          .optional()
          .describe(
            "Ask for a scripted run: one process, given a proxy URL per credential while it runs. The owners see the command. There is no call limit: the run is bounded by its time limit and each credential's method/path limits.",
          ),
      },
      async (
        args: {
          credential?: string;
          credentials?: string[];
          purpose: string;
          mode?: "once" | "standing";
          run?: { command: string };
        },
        extra: any,
      ) => {
        const refs =
          args.credentials ?? (args.credential ? [args.credential] : []);
        if (!refs.length || (args.credential && args.credentials))
          return text("Couldn't ask: give either credential or credentials.");
        if (refs.length > 1) {
          if (!args.run)
            return text(
              "Couldn't ask: several credentials are only for a scripted run; pass `run` too, or ask for each credential separately.",
            );
          return requestRun(refs, args.purpose, args.run, extra);
        }
        const run = args.run ? { command: args.run.command } : undefined;
        const result = requestCredential({
          credential: refs[0]!,
          sessionId: ctx.sessionId,
          requestedBy: ctx.user,
          purpose: args.purpose,
          ...(args.mode ? { mode: args.mode } : {}),
          ...(run ? { run } : {}),
        });
        if ("error" in result) return text(`Couldn't ask: ${result.error}`);
        if ("grant" in result)
          return text(
            `This session already holds a live grant for this credential.\n\n${result.instructions}`,
          );
        // The human-asks transport owns the wait; the keychain domain handler
        // swaps the owner's button label for grant instructions, so whatever
        // comes back here is already the text the model should act on.
        const { awaitBlockingAnswer, remindAsk } =
          await import("../../server/human-asks");
        // Stop holding the answer if the caller gives up, so a late approval
        // steers into the session instead of into this dead call. Wait
        // before reminding, so an answer during the reminder isn't missed.
        const waiting = awaitBlockingAnswer(result.transport.id, extra?.signal);
        if (result.resurfaced) await remindAsk(result.transport.id);
        const answer = await waiting;
        if (answer === null) {
          return text(
            `${result.ask.owner} hasn't answered yet — the ask stays open (${result.ask.id}) and their reply will arrive in this session as a message. Carry on with what doesn't need this credential, or stop and say what you're blocked on. Call request_credential again to remind them, or cancel_credential_ask to withdraw it.`,
          );
        }
        return text(answer);
      },
    ),
    tool(
      "call_credential",
      "Make one HTTPS API call with a credential this session holds a live grant for (see request_credential and list_grants). The credential is injected server-side; you never see it. The call goes to the credential's own host, within its method and path limits, and does not follow redirects. A once grant is spent by this call even if it fails. Returns the status, a few response headers and the text body (secret scrubbed, long bodies truncated, binary omitted), or only the status for a status-only credential. Stay within the purpose the owner approved; every call is audited.",
      {
        credential: z
          .string()
          .describe("Service slug (from list_credentials) or a credential id."),
        method: z.enum(BROKER_METHODS),
        path: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "Path and optional query on the credential's host, e.g. '/v1/deployments?limit=5'.",
          ),
        headers: z
          .record(z.string(), z.string().max(1000))
          .optional()
          .describe(
            "Optional: accept, content-type, if-match, if-none-match, idempotency-key, user-agent. Others are dropped.",
          ),
        body: z
          .string()
          .max(256 * 1024)
          .optional()
          .describe("Request body for POST, PUT, PATCH or DELETE."),
      },
      async (
        args: {
          credential: string;
          method: (typeof BROKER_METHODS)[number];
          path: string;
          headers?: Record<string, string>;
          body?: string;
        },
        extra: any,
      ) => {
        const result = await brokerCall({
          sessionId: ctx.sessionId,
          credential: args.credential,
          method: args.method,
          path: args.path,
          ...(args.headers ? { headers: args.headers } : {}),
          ...(args.body !== undefined ? { body: args.body } : {}),
          ...(extra?.signal ? { signal: extra.signal } : {}),
        });
        if ("error" in result) return text(`Couldn't call: ${result.error}.`);
        return text(JSON.stringify(result));
      },
    ),
    tool(
      "use_login",
      "Get the password of a login credential (a test account for a sign-in page) that its owner approved releasing to THIS session (request_credential, Release password). Writes the password to a 0600 file in this session's workspace and returns the sign-in page URL, the username and the file's path, never the password itself. Read it from the file in a script that types it into the page (for example Playwright's fill or CDP Input.insertText). Never print, echo or cat it, and never put it in a message, commit, screenshot, log or any other file. Each approval releases the password once, and the file is deleted after 30 minutes. Not available on a Runner.",
      {
        credential: z
          .string()
          .describe("The login's service slug (from list_credentials) or id."),
      },
      async ({ credential }: { credential: string }) => {
        const target = await loginTarget(ctx);
        if ("error" in target)
          return text(`Couldn't release: ${target.error}.`);
        const release = await claimLoginRelease({
          sessionId: ctx.sessionId,
          credential,
        });
        if ("error" in release)
          return text(`Couldn't release: ${release.error}.`);
        let file;
        try {
          file = await writeReleasedLogin({
            sessionId: ctx.sessionId,
            password: release.credential.secret,
            target,
          });
        } catch (error: any) {
          await release.undo();
          return text(
            `Couldn't release: ${error?.message || "the password file couldn't be written"}. The approval is still unused.`,
          );
        }
        return text(
          JSON.stringify({
            service: release.credential.service,
            loginUrl: release.credential.loginUrl,
            username: release.credential.username,
            passwordFile: file.path,
            deletedAt: file.expiresAt,
            next: "Open loginUrl in your browser, fill in the username, and type the password from passwordFile with a script that never prints it. Don't copy the password anywhere else. If you need to sign in again after the file is gone, ask with request_credential again.",
          }),
        );
      },
    ),
    tool(
      "run_with_credential",
      `Start a scripted run the credential's owner approved (request_credential with \`run\`): one process running exactly the approved command, on this server, in the session's workspace. The process gets KEYCHAIN_PROXY_URL, a base URL standing in for https://<credential host>: a request to $KEYCHAIN_PROXY_URL/v1/items goes to https://<host>/v1/items with the credential injected. A run approved with several \`credentials\` starts once every owner approved, and gets one URL per credential instead, KEYCHAIN_PROXY_URL_<SLUG> (slug upper-cased, other characters as _), each reaching only its own credential's host. The URLs work only for this run and all stop working when the process exits, times out or is stopped. Calls are held to each credential's method/path limits, are not capped in number, and every call is audited. The script gets a minimal environment (PATH, HOME, LANG, TMPDIR), so pass anything else on the command line, and never a secret. The run is a script run: it keeps going through Open Session restarts (the URLs hold requests while the server is back up), shows as a card in the session with its call counts, and this session is woken with how it ended, so start it and end your turn. Returns at once with a run id; credential_run_status shows progress. A Sandbox or Runner session cannot start one.`,
      {
        credential: z
          .string()
          .optional()
          .describe(
            "Service slug (from list_credentials) or a credential id. Give this or `credentials`.",
          ),
        credentials: z
          .array(z.string())
          .min(1)
          .max(MAX_RUN_CREDENTIALS)
          .optional()
          .describe(
            "Every credential of a run approved with several, as in request_credential.",
          ),
        command: z
          .string()
          .min(1)
          .max(MAX_RUN_COMMAND_CHARS)
          .describe("Exactly the command the owner approved."),
        cwd: z
          .string()
          .max(4000)
          .optional()
          .describe(
            "Directory to run in: absolute, or relative to the session's workspace (the default).",
          ),
        timeoutMinutes: z
          .number()
          .positive()
          .max(MAX_RUN_MINUTES)
          .optional()
          .describe(
            `Stop the run after this long. Default ${DEFAULT_RUN_MINUTES}, at most ${MAX_RUN_MINUTES}.`,
          ),
        title: z
          .string()
          .max(120)
          .optional()
          .describe(
            "Short name people see on the run's card, e.g. 'Archive agent customers'.",
          ),
      },
      async (args: {
        credential?: string;
        credentials?: string[];
        command: string;
        cwd?: string;
        timeoutMinutes?: number;
        title?: string;
      }) => {
        const where = runWorkspace(ctx, args.cwd);
        if ("error" in where) return text(`Couldn't start: ${where.error}.`);
        const result = await startCredentialRun({
          sessionId: ctx.sessionId,
          ...(args.credential ? { credential: args.credential } : {}),
          ...(args.credentials ? { credentials: args.credentials } : {}),
          command: args.command,
          cwd: where.cwd,
          logDir: scriptLogDir(ctx.sessionId),
          env: scriptEnv(ctx.sessionId),
          ...(args.timeoutMinutes !== undefined
            ? { timeoutMinutes: args.timeoutMinutes }
            : {}),
          ...(args.title ? { title: args.title } : {}),
          ...(ctx.user ? { startedBy: ctx.user } : {}),
        });
        if ("error" in result) return text(`Couldn't start: ${result.error}.`);
        return text(
          JSON.stringify({
            run: result.run,
            next: "It's running. Tell the person it started, then end your turn: this session is woken when it ends. credential_run_status shows progress meanwhile, and stop_credential_run ends it early.",
          }),
        );
      },
    ),
    tool(
      "credential_run_status",
      "Check a scripted run started with run_with_credential: running/exited/timed_out/stopped/revoked/failed/lost, exit code, calls made and calls refused (in total, and per credential under `credentials`), and the last few KB of its output (the full log is at logPath). Without a run id, lists this session's runs.",
      {
        runId: z
          .string()
          .optional()
          .describe("The run's id, 'sr-…'. Omit to list runs."),
      },
      async ({ runId }: { runId?: string }) => {
        if (!runId)
          return text(JSON.stringify(await listCredentialRuns(ctx.sessionId)));
        const status = await credentialRunStatus(runId, ctx.sessionId);
        return text(
          status
            ? JSON.stringify(status)
            : "No scripted run with that id in this session.",
        );
      },
    ),
    tool(
      "stop_credential_run",
      "Stop a running scripted run: its proxy URLs stop working at once and its process group is sent SIGTERM (SIGKILL after 10 seconds).",
      { runId: z.string().describe("The run's id, 'sr-…'.") },
      async ({ runId }: { runId: string }) => {
        const result = await stopCredentialRun(runId, ctx.sessionId);
        if ("error" in result) return text(`Couldn't stop: ${result.error}.`);
        return text(JSON.stringify(result.run));
      },
    ),
    tool(
      "cancel_credential_ask",
      "Withdraw one of this session's pending keychain asks (ids from list_grants). The owner is told it no longer needs an answer, and their buttons stop approving anything. Use it when the access is no longer needed or the ask should be replaced by a different one.",
      {
        askId: z.string().describe("The pending ask's id, e.g. 'ka-…'."),
      },
      async ({ askId }: { askId: string }) => {
        const result = cancelCredentialAsk(askId, ctx.sessionId);
        if ("error" in result)
          return text(`Couldn't withdraw ${askId}: ${result.error}.`);
        return text(`Withdrew keychain ask ${askId}.`);
      },
    ),
    tool(
      "register_credential",
      "Add a credential to the keychain, owned by the person driving this session, so this and later sessions can borrow it through request_credential. You supply only metadata. A card appears in the session where THEY paste the secret; it goes straight to the keychain and you never see it. For a username and password that must be typed into a sign-in page, pass kind 'login' with loginUrl and username (no host or limits): its owner later approves each release of the password with use_login, and the agent does see it then, so only register test accounts this way." +
        " This call waits until they save or decline (15 minutes at most) and returns the credential's id, service, host and owner. If the call is cut short, the card stays open: call again with the same service and host to keep waiting on it, or check list_credentials. Never ask anyone to paste a secret in chat; if they already did, tell them to rotate it. Check list_credentials first: service slugs are unique. Set allowedMethods / allowedPathPrefixes when the task needs less than full access. Interactive sessions with a signed-in teammate only.",
      {
        service: z
          .string()
          .min(1)
          .max(64)
          .describe(
            "Unique lowercase slug, e.g. 'acme-prod'. Use separate slugs for separate keys (prod vs sandbox).",
          ),
        host: z
          .string()
          .max(253)
          .optional()
          .describe(
            "API host the broker will call over HTTPS, e.g. 'api.example.test'. No scheme, port or path. Required unless kind is 'login'.",
          ),
        kind: z
          .enum(["api", "login"])
          .optional()
          .describe(
            "'api' (default): a token the broker injects as a header. 'login': a username and password typed into a sign-in page.",
          ),
        loginUrl: z
          .string()
          .max(2000)
          .optional()
          .describe(
            "For a login: the full https:// URL of the sign-in page, e.g. 'https://app.example.test/login'.",
          ),
        username: z
          .string()
          .max(200)
          .optional()
          .describe(
            "For a login: the username or email. Not secret; it is shown to the owner and to agents.",
          ),
        description: z
          .string()
          .max(240)
          .optional()
          .describe(
            "What the credential is, shown to teammates who borrow it.",
          ),
        allowedMethods: z
          .array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]))
          .optional()
          .describe("Limit broker calls to these methods. Omit for all."),
        allowedPathPrefixes: z
          .array(z.string().min(1).max(200))
          .max(20)
          .optional()
          .describe(
            "Limit broker calls to paths starting with these, e.g. ['/v1/customers']. Omit for all.",
          ),
        header: z
          .string()
          .max(64)
          .optional()
          .describe(
            "Header that carries the secret. Default 'Authorization' with the Bearer scheme.",
          ),
        scheme: z
          .string()
          .max(32)
          .optional()
          .describe(
            "Prefix before the secret in that header, e.g. 'Bearer' or 'Token'. Empty string for none.",
          ),
        statusOnly: z
          .boolean()
          .optional()
          .describe(
            "Calls return only the HTTP status, never the response. For keys whose API could echo the secret.",
          ),
      },
      async (
        args: {
          service: string;
          host?: string;
          kind?: "api" | "login";
          loginUrl?: string;
          username?: string;
          description?: string;
          allowedMethods?: string[];
          allowedPathPrefixes?: string[];
          header?: string;
          scheme?: string;
          statusOnly?: boolean;
        },
        extra: any,
      ) => {
        const refusal = registrationRefusal(ctx);
        if (refusal) return text(refusal);
        const owner = resolveTeammate(ctx.user)!.name;
        const login = githubLoginFor(ctx.user)!;
        // Load the store off-thread; the spec check below reads it.
        await ensureKeychainLoaded();
        let waiting;
        try {
          waiting = requestCredentialRegistration(
            ctx.sessionId,
            {
              owner,
              login,
              spec: {
                service: args.service,
                ...(args.host !== undefined ? { host: args.host } : {}),
                ...(args.kind ? { kind: args.kind } : {}),
                ...(args.loginUrl !== undefined
                  ? { loginUrl: args.loginUrl }
                  : {}),
                ...(args.username !== undefined
                  ? { username: args.username }
                  : {}),
                ...(args.description ? { description: args.description } : {}),
                ...(args.allowedMethods
                  ? { allowedMethods: args.allowedMethods }
                  : {}),
                ...(args.allowedPathPrefixes
                  ? { allowedPathPrefixes: args.allowedPathPrefixes }
                  : {}),
                ...(args.statusOnly ? { statusOnly: true } : {}),
                ...(args.header !== undefined || args.scheme !== undefined
                  ? {
                      injection: {
                        ...(args.header !== undefined
                          ? { header: args.header }
                          : {}),
                        ...(args.scheme !== undefined
                          ? { scheme: args.scheme }
                          : {}),
                      },
                    }
                  : {}),
              },
            },
            extra?.signal,
          );
        } catch (error: any) {
          return text(
            `Couldn't ask: ${error?.message || String(error)}. Nothing was registered.`,
          );
        }
        const result = await waiting;
        if (result.status === "pending")
          return text(
            `Stopped waiting, but the card stays open for ${owner} until ${new Date(result.request.expiresAt).toISOString()}. Call register_credential again with the same service and host to keep waiting, or check list_credentials for "${result.request.service}".`,
          );
        if (result.status === "declined")
          return text(
            `${owner} declined to add the credential. Don't ask again without their go-ahead.`,
          );
        if (result.status === "expired")
          return text(
            "Nobody saved the credential within 15 minutes, so the request closed. Nothing was registered.",
          );
        const c = result.credential;
        return text(
          JSON.stringify({
            registered: {
              id: c.id,
              service: c.service,
              host: c.host,
              owner: c.owner,
              ...(c.kind === "login"
                ? { kind: c.kind, loginUrl: c.loginUrl, username: c.username }
                : {}),
              ...(c.allowedMethods ? { allowedMethods: c.allowedMethods } : {}),
              ...(c.allowedPathPrefixes
                ? { allowedPathPrefixes: c.allowedPathPrefixes }
                : {}),
            },
            next:
              c.kind === "login"
                ? `Ask for it with request_credential({ credential: "${c.service}", purpose }); once its owner releases the password, use_login puts it in a file in this session's workspace.`
                : `Borrow it with request_credential({ credential: "${c.service}", purpose }). The secret is never available to you directly.`,
          }),
        );
      },
    ),
    tool(
      "list_grants",
      "List the keychain grants this session holds — which credential, once or standing, active/used/expired/revoked, and when each expires. Use it to check whether a grant you were given is still usable before relying on it.",
      {},
      async () => {
        const grants = listGrants({ sessionId: ctx.sessionId });
        const pending = listKeychainAsks({ sessionId: ctx.sessionId }).filter(
          (a) => a.status === "pending",
        );
        if (!grants.length && !pending.length) {
          return text(
            "This session holds no keychain grants and has no pending asks.",
          );
        }
        const creds = new Map(listCredentials().map((c) => [c.id, c]));
        const lines = grants.map((g) => {
          const service = creds.get(g.credentialId)?.service || g.credentialId;
          const when =
            g.status === "active" ? `expires ${g.expiresAt}` : g.status;
          return `- ${service} (${g.mode}) — ${when} — grant \`${g.id}\` — purpose: ${g.purpose}`;
        });
        const pendingLines = pending.map(
          (a) =>
            `- ${a.id}: awaiting ${a.owner}'s answer — purpose: ${a.purpose}`,
        );
        if (pendingLines.length)
          pendingLines.push(
            "Call request_credential again to remind the owner, or cancel_credential_ask to withdraw one.",
          );
        return text(
          [
            grants.length ? `Grants:\n${lines.join("\n")}` : "",
            pendingLines.length
              ? `Pending asks:\n${pendingLines.join("\n")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      },
    ),
  ];

  return createSdkMcpServer({ name: "opensession-keychain", tools });
}
