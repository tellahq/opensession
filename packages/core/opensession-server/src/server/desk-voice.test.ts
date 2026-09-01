import { describe, expect, test } from "bun:test";
import {
  buildVoiceSessionConfig,
  callVoiceMcpTool,
  DESK_VOICE_TURN_DETECTION,
  voiceToolTranscriptEntries,
} from "./desk-voice";
import { registerSessionControl, type SessionControl } from "./session-control";

describe("Desk voice Realtime session", () => {
  test("uses low-eagerness semantic VAD instead of default endpointing", async () => {
    expect(DESK_VOICE_TURN_DETECTION).toEqual({
      type: "semantic_vad",
      eagerness: "low",
      create_response: true,
      interrupt_response: true,
    });
    expect(
      (await buildVoiceSessionConfig("missing-test-session")).audio.input
        .turn_detection,
    ).toBe(DESK_VOICE_TURN_DETECTION);
  });

  test("accepts creator-filtered list_sessions calls from a voice turn", async () => {
    const sessions = [
      {
        id: "os-alex",
        title: "Alex session",
        state: "idle" as const,
        queuedCount: 0,
        controllable: true,
        createdBy: "Alex Rivera",
        createdByLogin: "arivera",
        createdAt: "2026-08-06T09:30:00.000Z",
        lastActivity: "2026-08-06T10:00:00.000Z",
      },
      {
        id: "os-other",
        title: "Other session",
        state: "idle" as const,
        queuedCount: 0,
        controllable: true,
        createdBy: "Other Person",
        createdByLogin: "other",
        createdAt: "2026-08-06T09:30:00.000Z",
        lastActivity: "2026-08-06T10:00:00.000Z",
      },
    ];
    registerSessionControl({
      listSessions: () =>
        sessions as ReturnType<SessionControl["listSessions"]>,
      getSession: () => undefined,
      transcriptTail: async () => [],
      answerQuestion: () => false,
      deliverToSession: async () => ({
        status: "error" as const,
        message: "not used",
      }),
      cancelSession: () => false,
      reparentSession: async () => ({ ok: false, error: "not used" }),
      createSession: async () => ({
        id: "unused",
        createdBy: "Test",
        createdAt: "2026-08-06T09:30:00.000Z",
      }),
    });

    const tools = (await buildVoiceSessionConfig("missing-test-session")).tools;
    const listSessions = tools.find((tool) => tool.name === "list_sessions") as
      | { parameters: { properties: Record<string, unknown> } }
      | undefined;
    expect(listSessions?.parameters.properties).toHaveProperty("createdBy");
    expect(
      tools.some((tool) => tool.name === "opensession-admin_list_automations"),
    ).toBe(true);
    const result = (await callVoiceMcpTool(
      "Test",
      "missing-test-session",
      "list_sessions",
      {
        createdBy: "ARIVERA",
      },
    )) as { found: boolean; result: { content: Array<{ text: string }> } };
    expect(result.found).toBe(true);
    expect(result.result.content[0].text).toContain("os-alex");
    expect(result.result.content[0].text).not.toContain("os-other");
  });

  test("persists voice actions as linked, complete tool calls", () => {
    const output = { sessions: ["x".repeat(40_000)] };
    const entries = voiceToolTranscriptEntries(
      "call-1",
      "list_sessions",
      { createdBy: "Alex" },
      output,
      "2026-08-07T12:00:00.000Z",
    );

    expect(entries[0]).toMatchObject({
      id: "voice-tu-call-1",
      type: "tool_use",
      toolUseId: "voice-tu-call-1",
      toolInput: { createdBy: "Alex" },
    });
    expect(entries[1]).toMatchObject({
      id: "voice-tr-call-1",
      type: "tool_result",
      toolUseId: "voice-tu-call-1",
    });
    expect(entries[1].content).toBe(JSON.stringify(output));
    expect(entries[1].content.length).toBeGreaterThan(40_000);
    expect(
      voiceToolTranscriptEntries(
        "call-2",
        "list_sessions",
        {},
        {
          isError: true,
          content: [{ type: "text", text: "failed" }],
        },
      )[1].isError,
    ).toBe(true);
  });
});
