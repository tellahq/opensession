/**
 * AgentModule for the code.storage integration registry entry.
 *
 * Registers the inbound webhook route (push → PR-cache invalidation, see
 * webhook.ts) on the webhook server; everything else here is inert — the
 * actual support (JWT minting, REST client, credential helper in this
 * directory) is gated purely on config presence (codeStorageConfig()), so
 * onboarding/doctor can enumerate the integration and /health can report it.
 */

import type { AgentModule } from "../../agents/types";
import { codeStorageConfig } from "../config";
import { handleCsWebhook } from "./webhook";

export class CodeStorageIntegration implements AgentModule {
  name = "codestorage";

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    return new Map([
      ["POST /codestorage/webhook", (req: Request) => handleCsWebhook(req)],
    ]);
  }

  async startup(): Promise<void> {}

  async shutdown(): Promise<void> {}

  health(): Record<string, unknown> {
    const cfg = codeStorageConfig();
    return cfg
      ? { status: "operational", configured: true, org: cfg.org }
      : { status: "unconfigured", configured: false };
  }
}
