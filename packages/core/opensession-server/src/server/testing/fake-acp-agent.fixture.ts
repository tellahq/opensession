import { createInterface } from "node:readline";

const send = (message: object) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let resumed = false;
let promptId: number | undefined;
let permissionId: number | undefined;
const update = (value: object) =>
  send({
    method: "session/update",
    params: { sessionId: "fake-session", update: value },
  });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: process.env.FAKE_NO_RESUME !== "1",
            promptCapabilities: { image: true },
          },
        },
      });
      break;
    case "session/new":
      send({ id: message.id, result: { sessionId: "fake-session" } });
      break;
    case "session/load":
      resumed = true;
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Historical answer" },
      });
      send({ id: message.id, result: {} });
      break;
    case "session/prompt":
      promptId = message.id;
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: resumed ? "Resumed" : "Hello" },
      });
      if (message.params.prompt[0].text === "wait") break;
      if (message.params.prompt[0].text === "crash") process.exit(9);
      update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Private thought" },
      });
      update({
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect file", status: "in_progress", priority: "high" },
        ],
      });
      update({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read",
        kind: "read",
        rawInput: { path: "example.txt" },
      });
      permissionId = 1000;
      send({
        id: permissionId,
        method: "session/request_permission",
        params: {
          sessionId: "fake-session",
          options: [
            { optionId: "once", kind: "allow_once", name: "Allow once" },
            { optionId: "always", kind: "allow_always", name: "Allow always" },
          ],
        },
      });
      break;
    case "session/cancel":
      if (promptId) send({ id: promptId, result: { stopReason: "cancelled" } });
      break;
    default:
      if (message.id === permissionId) {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: JSON.stringify(message.result) },
            },
          ],
        });
        send({ id: promptId, result: { stopReason: "end_turn" } });
      }
  }
});
