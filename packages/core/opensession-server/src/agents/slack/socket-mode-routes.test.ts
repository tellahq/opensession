import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

// The isolated test runner supplies private state directories. Never start the agent.
process.env.SLACK_SOCKET_MODE = "true";
process.env.SLACK_APP_TOKEN = "xapp-synthetic";
process.env.SLACK_SIGNING_SECRET = "";
const { SlackAgent } = await import("./index");

test("Socket Mode keeps both HTTP routes registered and rejects even an empty-key HMAC", async () => {
  const agent = new SlackAgent();
  const routes = agent.getRoutes();
  for (const path of ["/slack/events", "/slack/actions"]) {
    const route = routes.get(`POST ${path}`);
    expect(route).toBeDefined();
    const body = path.endsWith("events")
      ? JSON.stringify({ type: "url_verification", challenge: "synthetic" })
      : "payload=%7B%22type%22%3A%22block_actions%22%7D";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", "").update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const url = new URL(path, "https://example.test");
    for (const headers of [
      new Headers(),
      new Headers({
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      }),
    ]) {
      const response = await route!(
        new Request(url, { method: "POST", body, headers }),
        url,
      );
      expect(response.status).toBe(401);
    }
  }
  expect(agent.health().transport).toBe("socket");
});
