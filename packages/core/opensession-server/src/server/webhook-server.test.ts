import { describe, expect, test } from "bun:test";
import { configureWebhookRoutes, handleWebhookRequest } from "./webhook-server";

const agent = {
  name: "test",
  getRoutes() {
    return new Map([
      ["POST /github/webhook", async () => new Response("github")],
      [
        "GET /assets/*",
        async (_req: Request, url: URL) => new Response(url.pathname),
      ],
    ]);
  },
  async startup() {},
  async shutdown() {},
  health() {
    return {};
  },
};

describe("public webhook registry", () => {
  test("dispatches only exact methods and registered wildcard prefixes", async () => {
    configureWebhookRoutes([agent as any]);
    expect(
      await (
        await handleWebhookRequest(
          new Request("https://ingress.test/github/webhook", {
            method: "POST",
          }),
        )
      )?.text(),
    ).toBe("github");
    expect(
      await handleWebhookRequest(
        new Request("https://ingress.test/github/webhook"),
      ),
    ).toBeUndefined();
    expect(
      await (
        await handleWebhookRequest(
          new Request("https://ingress.test/assets/one"),
        )
      )?.text(),
    ).toBe("/assets/one");
    expect(
      await handleWebhookRequest(
        new Request("https://ingress.test/api/sessions"),
      ),
    ).toBeUndefined();
  });
});
