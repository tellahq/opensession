/**
 * Plain Agent Module — handles Plain webhook events for the configured mention.
 */
import type { AgentModule } from "../types";
import type { FeedProvider } from "../../server/feeds";
import { verifyPlainSignature } from "../../server/shared/signature";
import {
  MAX_WEBHOOK_BODY_BYTES,
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../../server/shared/bounded-body";
import {
  handleWebhook,
  activeSessions,
  pendingConfirmations,
} from "./handlers";
import type { PlainWebhookPayload } from "./handlers";
import { configuredIntegration } from "../../server/config";

const PLAIN_WEBHOOK_SECRET = process.env.PLAIN_WEBHOOK_SECRET || "";

// Clean up old pending confirmations every 5 minutes
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export class PlainAgent implements AgentModule {
  name = "plain";

  /**
   * The Support queue as a generic sidebar feed (the feeds design W5):
   * TODO threads with priority lanes; item.meta carries the full
   * SupportThreadSummary so the frontend keeps rendering its bespoke
   * SupportRow (hover card, mark-done, filters) inside the generic band.
   * The 30s route cache is superseded by the feeds layer's 60s cache;
   * mark-done invalidates it (routes/plain.ts → invalidateFeedCache).
   */
  getFeed(): FeedProvider | null {
    return {
      descriptor: {
        id: "plain",
        title: "Plain",
        refKind: "plain",
        tileBg: "#0d9488",
        mcpServers: ["plain"],
        lanes: [
          { key: "0", label: "Urgent", dot: "var(--red)" },
          { key: "1", label: "High", dot: "var(--yellow)" },
          { key: "2", label: "Normal", dot: "var(--blue)" },
          { key: "3", label: "Low", dot: "var(--text-faint)" },
        ],
        attentionLane: "0",
        searchMeta: ["customer.name", "customer.email", "previewText"],
        // Generic band filters (the feeds design): the old bespoke
        // assignee/label menu, expressed as meta-mode filter specs.
        filters: [
          {
            key: "assignee",
            label: "Assignee",
            mode: "meta",
            field: "assignee",
            options: [{ value: "__unassigned__", label: "Unassigned" }],
            optionsFromItems: { value: "name", label: "name" },
          },
          {
            key: "label",
            label: "Label",
            mode: "meta",
            field: "labels",
            optionsFromItems: { value: "name", label: "name" },
          },
        ],
      },
      async listItems(): Promise<import("../../server/feeds").FeedItem[]> {
        const { listTodoThreads } = await import("./api");
        const threads = await listTodoThreads(100);
        return threads.map((t) => ({
          id: t.id,
          title: t.title || t.customer?.name || t.customer?.email || "Ticket",
          preview: t.previewText || undefined,
          lane: String(t.priority ?? 2),
          ts: t.statusChangedAt
            ? Date.parse(t.statusChangedAt) || undefined
            : undefined,
          meta: t as unknown as Record<string, unknown>,
        }));
      },
    };
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<
      string,
      (req: Request, url: URL) => Promise<Response>
    >();

    routes.set("POST /plain/webhook", async (req) => {
      let body: string;
      try {
        body = await readRequestTextWithinLimit(req, MAX_WEBHOOK_BODY_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError)
          return webhookBodyTooLargeResponse(MAX_WEBHOOK_BODY_BYTES);
        throw error;
      }
      const signature = req.headers.get("plain-request-signature") || "";

      if (!verifyPlainSignature(body, signature, PLAIN_WEBHOOK_SECRET)) {
        console.error("[plain] Invalid webhook signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      try {
        const payload = JSON.parse(body) as PlainWebhookPayload;
        return handleWebhook(payload);
      } catch (e) {
        console.error("[plain] Error parsing webhook payload:", e);
        return Response.json({ error: "Invalid payload" }, { status: 400 });
      }
    });

    return routes;
  }

  async startup(): Promise<void> {
    if (configuredIntegration("seeds").enabled === true) {
    }

    // Start confirmation cleanup timer
    cleanupInterval = setInterval(
      () => {
        const now = Date.now();
        const timeout = 30 * 60 * 1000; // 30 minutes
        for (const [key, pending] of pendingConfirmations) {
          if (now - pending.timestamp > timeout) {
            pendingConfirmations.delete(key);
          }
        }
      },
      5 * 60 * 1000,
    );

    console.log("[plain] Agent started");
  }

  async shutdown(): Promise<void> {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
    console.log("[plain] Agent shut down");
  }

  health(): Record<string, unknown> {
    return {
      status: "operational",
      activeSessions: activeSessions.size,
      pendingConfirmations: pendingConfirmations.size,
    };
  }
}
