/**
 * opensession-keychain — borrow a teammate's credential for a stated purpose.
 *
 * No tool handles secret values: list what exists, ask an owner
 * for a scoped grant, list this session's grants. Approved calls go through
 * the broker (routes/keychain.ts) with the credential injected server-side, so
 * the model never holds the secret and cannot leak one it never had.
 * Mac requests instead resolve one Keychain item locally and return status only.
 *
 * Interactive runs ONLY — same boundary as opensession-humans. An ask is a DM
 * to a teammate carrying a model-authored "purpose" string; letting untrusted
 * ticket text reach it would turn the agent into a social-engineering proxy
 * against our own team ("I need the Stripe key to process this refund").
 *
 * Registration is deliberately not a tool: a secret pasted into a session
 * prompt is a secret in the transcript. Credentials are added over HTTP.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { githubLoginFor } from "../../server/shared/user-mappings";
import {
  macKeychainRequestSchema,
  macKeychainRequests,
} from "../../server/mac-keychain-requests";
import {
  listCredentials,
  listGrants,
  listKeychainAsks,
  requestCredential,
} from "../../server/keychain";

export interface KeychainToolContext {
  sessionId: string;
  /** Who is driving — recorded on the ask so the owner sees who is asking. */
  user: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createKeychainMcpServer(ctx: KeychainToolContext) {
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
            "The keychain is empty. Credentials are registered by their owner in the Open Session UI (Settings → Account) — never paste a secret into a session.",
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
      "Ask a credential's owner to lend it to THIS session for a stated purpose. They get a DM (or a card, if they're driving a session) with Approve once / Approve standing / Decline, and this call blocks until they answer. On approval you receive broker instructions — a URL that injects the credential server-side; you never see the secret itself. Ask only when you actually need the access now, state the real purpose (the owner is approving that sentence, and every call is audited against it), and prefer 'once' unless the task genuinely needs repeated calls. If they decline, don't re-ask.",
      {
        credential: z
          .string()
          .describe("Service slug (from list_credentials) or a credential id."),
        purpose: z
          .string()
          .describe(
            "What you need it for, one specific sentence the owner can judge — e.g. 'read the project's latest deployment status to diagnose the failing preview'.",
          ),
        mode: z
          .enum(["once", "standing"])
          .optional()
          .describe(
            "'once' (default) = a single broker call, expires in an hour. 'standing' = repeated calls for up to 7 days; the owner can approve either regardless of what you request.",
          ),
      },
      async (args: {
        credential: string;
        purpose: string;
        mode?: "once" | "standing";
      }) => {
        const result = requestCredential({
          credential: args.credential,
          sessionId: ctx.sessionId,
          requestedBy: ctx.user,
          purpose: args.purpose,
          ...(args.mode ? { mode: args.mode } : {}),
        });
        if ("error" in result) return text(`Couldn't ask: ${result.error}`);
        // The human-asks transport owns the wait; the keychain domain handler
        // swaps the owner's button label for grant instructions, so whatever
        // comes back here is already the text the model should act on.
        const { awaitBlockingAnswer } = await import("../../server/human-asks");
        const answer = await awaitBlockingAnswer(result.transport.id);
        if (answer === null) {
          return text(
            `${result.ask.owner} hasn't answered yet — the ask stays open (${result.ask.id}) and their reply will arrive in this session as a message. Carry on with what doesn't need this credential, or stop and say what you're blocked on.`,
          );
        }
        return text(answer);
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
