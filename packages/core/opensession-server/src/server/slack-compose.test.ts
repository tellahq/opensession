import { afterEach, describe, expect, test } from "bun:test";
import {
  cancelPendingSlackComposer,
  claimPendingSlackComposer,
  openSlackComposer,
  pendingSlackComposers,
  resendPendingSlackComposer,
  restorePendingSlackComposer,
  sendPendingSlackComposer,
} from "./slack-compose";
import { handleSlackComposeRoutes } from "./routes/slack-compose";
import { createMcpRuntime } from "./mcp-runtime";
import {
  createSlackComposeMcpServer,
  slackComposeOutcomeMessage,
} from "../agents/slack/slack-compose-tools";
import type { RouteContext } from "./routes/context";

function routeContext(
  path: string,
  authUser: RouteContext["authUser"],
  options: { method?: string; body?: object } = {},
): RouteContext {
  const req = new Request(`http://127.0.0.1:3850${path}`, {
    method: options.method ?? "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.body ?? { message: "Latest response" }),
  });
  return { req, url: new URL(req.url), path, publicPrefix: "", authUser };
}

afterEach(() => {
  for (const [sessionId, pending] of pendingSlackComposers) {
    if (pending.status === "sending")
      restorePendingSlackComposer(sessionId, pending.request.id);
    cancelPendingSlackComposer(sessionId, pending.request.id);
  }
});

describe("Slack composer lifecycle", () => {
  test("opens a human-requested composer from the session route", async () => {
    const path = "/api/sessions/os-test/slack-composer/open";
    const response = await handleSlackComposeRoutes(
      routeContext(path, {
        login: "michiel",
        name: "Michiel Westerbeek",
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      message: "Latest response",
      images: [],
    });
    expect(pendingSlackComposers.get("os-test")?.request.message).toBe(
      "Latest response",
    );
  });

  test("requires sign-in to open a composer from the session route", async () => {
    const path = "/api/sessions/os-test/slack-composer/open";
    const response = await handleSlackComposeRoutes(routeContext(path, null));
    expect(response?.status).toBe(401);
    expect(pendingSlackComposers.has("os-test")).toBe(false);
  });

  test("saves edits for reconnecting viewers", async () => {
    void openSlackComposer("os-test", { message: "Original response" });
    const requestId = pendingSlackComposers.get("os-test")!.request.id;
    const path = "/api/sessions/os-test/slack-composer";
    const response = await handleSlackComposeRoutes(
      routeContext(
        path,
        { login: "kent", name: "Kent de Bruin" },
        {
          method: "PATCH",
          body: {
            requestId,
            message: "Edited response",
            channel: "C4407",
            screenshots: [],
          },
        },
      ),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      id: requestId,
      message: "Edited response",
      channel: "C4407",
      images: [],
    });
    const frames: object[] = [];
    resendPendingSlackComposer("os-test", (frame) => frames.push(frame));
    expect(frames).toEqual([
      {
        type: "slack_composer",
        sessionId: "os-test",
        request: {
          id: requestId,
          message: "Edited response",
          channel: "C4407",
          images: [],
        },
      },
    ]);
  });

  test("resolves when the human sends", async () => {
    const { result } = openSlackComposer("os-test", {
      message: "Status update",
    });
    const request = pendingSlackComposers.get("os-test")?.request;
    expect(request?.message).toBe("Status update");
    expect(claimPendingSlackComposer("os-test", request!.id)).toBe(true);
    expect(
      sendPendingSlackComposer("os-test", request!.id, {
        id: "C1",
        name: "engineering",
      }),
    ).toBe(true);
    expect(await result).toEqual({
      status: "sent",
      channel: { id: "C1", name: "engineering" },
    });
  });

  test("cancel resolves without sending", async () => {
    const { result } = openSlackComposer("os-test", {});
    const requestId = pendingSlackComposers.get("os-test")!.request.id;
    expect(cancelPendingSlackComposer("os-test", requestId)).toBe(true);
    expect(await result).toEqual({ status: "cancelled" });
  });

  test("allows only one pending composer per session", () => {
    void openSlackComposer("os-test", {});
    expect(() => openSlackComposer("os-test", {})).toThrow(
      "already has a Slack composer open",
    );
  });

  test("only one sender can claim a pending composer", () => {
    void openSlackComposer("os-test", {});
    const requestId = pendingSlackComposers.get("os-test")!.request.id;
    expect(claimPendingSlackComposer("os-test", requestId)).toBe(true);
    expect(claimPendingSlackComposer("os-test", requestId)).toBe(false);
    expect(cancelPendingSlackComposer("os-test", requestId)).toBe(false);
    restorePendingSlackComposer("os-test", requestId);
    expect(cancelPendingSlackComposer("os-test", requestId)).toBe(true);
  });

  test("replay authoritatively clears a stale composer", () => {
    const frames: object[] = [];
    resendPendingSlackComposer("os-test", (frame) => frames.push(frame));
    expect(frames).toEqual([
      {
        type: "slack_composer",
        sessionId: "os-test",
        request: null,
      },
    ]);
  });

  test("an agent's draft outlives its MCP call and still sends", async () => {
    const deliveries: string[] = [];
    let delivered!: () => void;
    const deliveredOnce = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    // A client that gives up on any request after 50ms, standing in for the
    // agent-side request timeout that used to kill the draft.
    const callTimeoutMs = 50;
    const runtime = await createMcpRuntime({
      mcpServers: [],
      deniedToolIds: new Set(),
      inProcessMcp: {
        "opensession-slack": createSlackComposeMcpServer({
          sessionId: "os-test",
          deliver: async (sessionId, _requestId, message) => {
            expect(sessionId).toBe("os-test");
            deliveries.push(message);
            delivered();
          },
        }),
      },
      callTimeoutMs,
    });
    const call = await runtime.callExact(
      "opensession-slack_compose_message",
      { message: "Render latency update" },
      { toolCallId: "compose-1" },
    );
    const requestId = pendingSlackComposers.get("os-test")!.request.id;
    expect(call.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(`Opened Slack draft ${requestId}`),
    });
    // The agent's side is gone: its turn ended and its MCP connections closed.
    await runtime.close();
    await Bun.sleep(callTimeoutMs * 4);

    const frames: object[] = [];
    resendPendingSlackComposer("os-test", (frame) => frames.push(frame));
    expect(frames).toEqual([
      {
        type: "slack_composer",
        sessionId: "os-test",
        request: {
          id: requestId,
          message: "Render latency update",
          images: [],
        },
      },
    ]);
    expect(deliveries).toEqual([]);

    expect(claimPendingSlackComposer("os-test", requestId)).toBe(true);
    expect(
      sendPendingSlackComposer(
        "os-test",
        requestId,
        { id: "C1", name: "engineering" },
        "https://acme.slack.com/archives/C1/p1",
      ),
    ).toBe(true);
    await deliveredOnce;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain(
      `The person sent the Slack draft ${requestId} to #engineering: https://acme.slack.com/archives/C1/p1`,
    );
    expect(deliveries[0]).toStartWith(
      '<opensession:context source="background-wait">',
    );
    expect(pendingSlackComposers.has("os-test")).toBe(false);
  });

  test("a cancelled agent draft reports back to the session", () => {
    expect(
      slackComposeOutcomeMessage("draft-1", { status: "cancelled" }),
    ).toContain(
      "The person cancelled the Slack draft draft-1. Nothing was sent.",
    );
  });
});
