/**
 * Linear Agent Module — handles Linear agent sessions, OAuth, and issue webhooks.
 */
import type { AgentModule } from "../types";
import { verifyLinearSignature } from "../../server/shared/signature";
import {
  MAX_WEBHOOK_BODY_BYTES,
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../../server/shared/bounded-body";
import { loadTokens, handleAuthorize, handleCallback } from "./oauth";
import type { LinearTokens } from "./oauth";
import { handleAgentSession, handleIssueUpdate } from "./handlers";
import type { AgentSessionWebhook, IssueWebhook } from "./handlers";
import { activeSessions, loadActiveSessionsOnStartup } from "./session";

const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET || "";

let tokens: LinearTokens = {};

export class LinearAgent implements AgentModule {
  name = "linear";

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<
      string,
      (req: Request, url: URL) => Promise<Response>
    >();

    // Webhook endpoint
    routes.set("POST /webhook", async (req) => {
      let body: string;
      try {
        body = await readRequestTextWithinLimit(req, MAX_WEBHOOK_BODY_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError)
          return webhookBodyTooLargeResponse(MAX_WEBHOOK_BODY_BYTES);
        throw error;
      }
      const signature = req.headers.get("linear-signature") || "";

      if (!verifyLinearSignature(body, signature, LINEAR_WEBHOOK_SECRET)) {
        console.error("[linear] Invalid webhook signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      const payload = JSON.parse(body);
      console.log(`[linear] Webhook: ${payload.type} - ${payload.action}`);

      if (
        payload.type === "AgentSessionEvent" ||
        payload.type === "AgentSession"
      ) {
        return handleAgentSession(payload as AgentSessionWebhook, tokens);
      }

      if (payload.type === "Issue") {
        return handleIssueUpdate(payload as IssueWebhook, tokens);
      }

      return Response.json({ ok: true });
    });

    // OAuth
    routes.set("GET /oauth/authorize", async () => {
      return handleAuthorize();
    });

    routes.set("GET /oauth/callback", async (req, url) => {
      return handleCallback(req, url, tokens);
    });

    return routes;
  }

  async startup(): Promise<void> {
    tokens = await loadTokens();
    await loadActiveSessionsOnStartup(tokens);
    console.log("[linear] Agent started");
  }

  async shutdown(): Promise<void> {
    for (const [, session] of activeSessions) {
      if (session.abortController) {
        session.abortController.abort();
      }
    }
    console.log("[linear] Agent shut down");
  }

  health(): Record<string, unknown> {
    return {
      status: "operational",
      activeSessions: activeSessions.size,
      sessions: Array.from(activeSessions.values()).map((s) => ({
        branch: s.branch,
        issue: s.issueIdentifier,
        isPlanning: s.phase === "planning",
      })),
    };
  }
}
