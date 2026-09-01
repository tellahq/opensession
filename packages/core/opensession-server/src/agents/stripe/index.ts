/**
 * Stripe Agent Module — receives Stripe webhooks and fires automation events.
 *
 * Currently it handles `charge.dispute.created`: when a chargeback is filed,
 * it fires the `stripe:charge.dispute.created` event, which the dispute
 * investigation automation subscribes to via its eventKey.
 */
import type { AgentModule } from "../types";
import { verifyStripeSignature } from "../../server/shared/signature";
import {
  MAX_WEBHOOK_BODY_BYTES,
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../../server/shared/bounded-body";
import { handleStripeEvent } from "./handlers";

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

export class StripeAgent implements AgentModule {
  name = "stripe";

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<
      string,
      (req: Request, url: URL) => Promise<Response>
    >();

    routes.set("POST /stripe/webhook", async (req) => {
      let body: string;
      try {
        body = await readRequestTextWithinLimit(req, MAX_WEBHOOK_BODY_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError)
          return webhookBodyTooLargeResponse(MAX_WEBHOOK_BODY_BYTES);
        throw error;
      }
      const signature = req.headers.get("stripe-signature") || "";

      if (!verifyStripeSignature(body, signature, STRIPE_WEBHOOK_SECRET)) {
        console.error("[stripe] Invalid webhook signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      let event;
      try {
        event = JSON.parse(body);
      } catch (e) {
        console.error("[stripe] Error parsing webhook payload:", e);
        return Response.json({ error: "Invalid payload" }, { status: 400 });
      }

      // Fire-and-forget: ack Stripe immediately, run the automation async.
      void handleStripeEvent(event).catch((e) =>
        console.error("[stripe] Error handling event:", e),
      );

      return Response.json({ ok: true });
    });

    return routes;
  }

  async startup(): Promise<void> {
    console.log("[stripe] Agent started");
  }

  async shutdown(): Promise<void> {
    console.log("[stripe] Agent shut down");
  }

  health(): Record<string, unknown> {
    return {
      status: STRIPE_WEBHOOK_SECRET
        ? "operational"
        : "missing STRIPE_WEBHOOK_SECRET",
    };
  }
}
