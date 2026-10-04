import { expect, spyOn, test } from "bun:test";
import { handleAgentResourceRoutes } from "./agent-resources";
import { agentResources } from "../agent-resources";
import {
  registerSessionControl,
  type SessionControl,
} from "../session-control";
import type { RouteContext } from "./context";
import type { AgentResourceEvent } from "../../shared/agent-resources";

function context(path: string, method = "GET", body?: object): RouteContext {
  const url = new URL(`http://example.test${path}`);
  return {
    url,
    path,
    publicPrefix: "/opensession",
    req: new Request(url, {
      method,
      ...(body
        ? {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }
        : {}),
    }),
  };
}

test("history reads do not subscribe or launch collection", async () => {
  const subscribe = spyOn(agentResources, "subscribe");
  try {
    const response = await handleAgentResourceRoutes(
      context("/api/agent-resources/history"),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ samples: [] });
    expect(subscribe).not.toHaveBeenCalled();
  } finally {
    subscribe.mockRestore();
  }
});

test("SSE cancel releases its subscriber and publishes only sample data", async () => {
  let emit: ((event: AgentResourceEvent) => void) | undefined;
  let stopped = 0;
  const subscribe = spyOn(agentResources, "subscribe").mockImplementation(
    (listener) => {
      emit = listener;
      return () => {
        stopped++;
      };
    },
  );
  try {
    const response = await handleAgentResourceRoutes(
      context("/api/agent-resources/events"),
    );
    expect(response?.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response!.body!.getReader();
    emit!({ status: "unavailable" });
    const value = await reader.read();
    expect(new TextDecoder().decode(value.value)).toBe(
      'data: {"status":"unavailable"}\n\n',
    );
    await reader.cancel();
    expect(stopped).toBe(1);
  } finally {
    subscribe.mockRestore();
  }
});

test("slow SSE consumers are disconnected without growing a sample queue", async () => {
  let emit: ((event: AgentResourceEvent) => void) | undefined;
  let stopped = 0;
  const subscribe = spyOn(agentResources, "subscribe").mockImplementation(
    (listener) => {
      emit = listener;
      return () => {
        stopped++;
      };
    },
  );
  try {
    await handleAgentResourceRoutes(context("/api/agent-resources/events"));
    emit!({ status: "unavailable" });
    emit!({ status: "unavailable" });
    expect(stopped).toBe(1);
  } finally {
    subscribe.mockRestore();
  }
});

test("stop uses existing session cancellation and checks person and body bounds", async () => {
  const cancelled: string[] = [];
  // SAFETY: this route invokes only cancelSession on the test service.
  registerSessionControl({
    cancelSession: async (id) => {
      cancelled.push(id);
      return true;
    },
  } as SessionControl);
  expect(
    (
      await handleAgentResourceRoutes(
        context("/api/agent-resources/stop", "POST", { sessionId: "example" }),
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await handleAgentResourceRoutes(
        context("/api/agent-resources/stop", "POST", {
          sessionId: "example",
          user: "demo",
          extra: "x".repeat(4096),
        }),
      )
    )?.status,
  ).toBe(400);
  const automation = context("/api/agent-resources/stop", "POST", {
    sessionId: "example",
    user: "demo",
  });
  automation.authUser = {
    name: "demo",
    login: "demo",
    ...{ automation: true },
  };
  expect((await handleAgentResourceRoutes(automation))?.status).toBe(403);
  const response = await handleAgentResourceRoutes(
    context("/api/agent-resources/stop", "POST", {
      sessionId: "example",
      user: "demo",
    }),
  );
  expect(await response?.json()).toEqual({ ok: true });
  expect(cancelled).toEqual(["example"]);
});
