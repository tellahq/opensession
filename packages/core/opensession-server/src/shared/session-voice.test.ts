import { expect, test } from "bun:test";
import {
  isSessionVoiceHelperTarget,
  SESSION_VOICE_HELPER_TARGETS,
  SESSION_VOICE_INSTRUCTIONS,
  SESSION_VOICE_TARGETS,
  sessionVoiceContext,
} from "./session-voice";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";

function entry(
  id: string,
  type: TranscriptEntry["type"],
  content: string,
): TranscriptEntry {
  return { id, type, content, timestamp: "2026-09-18T10:00:00Z" };
}

test("voice context contains the thread's answers and tool results, never hidden engine context", () => {
  const context = sessionVoiceContext([
    entry("one", "user", "Why did the test fail?"),
    entry("secret", "system", "Hidden system instructions"),
    { ...entry("thought", "assistant", "Hidden reasoning"), isReasoning: true },
    {
      ...entry("injection", "user", "Hidden context"),
      contextInjection: { source: "private" },
    },
    {
      ...entry("tool", "tool_result", "The retry loop ran twice"),
      toolName: "bash",
    },
    entry("answer", "assistant", "Fixed the retry loop"),
  ]);
  expect(context).toContain("Why did the test fail?");
  expect(context).toContain("The retry loop ran twice");
  expect(context).toContain("Fixed the retry loop");
  expect(context).not.toContain("Hidden");
  expect(context.indexOf("retry loop ran")).toBeLessThan(
    context.indexOf("Fixed"),
  );
});

test("helper targets are tool-less; explicit user tasks go directly to the session agent", () => {
  expect([...SESSION_VOICE_HELPER_TARGETS]).toEqual([
    "luna",
    "terra",
    "conversation",
  ]);
  expect([...SESSION_VOICE_TARGETS]).toEqual([
    ...SESSION_VOICE_HELPER_TARGETS,
    "session_agent",
  ]);
  expect(isSessionVoiceHelperTarget("conversation")).toBe(true);
  expect(isSessionVoiceHelperTarget("session_agent")).toBe(false);
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "An explicit request is sufficient authorization",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "without asking for another approval or spoken yes",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "ask one short clarification before dispatching",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "Send additional requested tasks while earlier ones are running",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain("conversation for the hardest");
});

test("voice context is bounded and explicitly marks truncated messages", () => {
  const context = sessionVoiceContext(
    Array.from({ length: 1000 }, (_, index) =>
      entry(String(index), "assistant", `${index}: ${"x".repeat(10_000)}`),
    ),
  );
  expect(context.length).toBeLessThanOrEqual(48_080);
  expect(context).toContain("999:");
  expect(context).toContain('"truncated":true');
  expect(context).not.toContain('"text":"0:');
});

test("voice handoff requests direct work without delegation wrappers or changing the user's scope", () => {
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "task message delivered verbatim",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    'Do not add a delegation preamble such as "Please propose a task for the agent"',
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "Keep the reason and conversational acknowledgements out of prompt",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "if they explicitly ask only for a plan, proposal, or explanation, that is the task",
  );
});

test("clear intent steers without repetition and natural farewells close voice only", () => {
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "without repeating, paraphrasing, or summarizing",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain("normal steering path");
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "End the call with end_voice_call",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain('"bye"');
  expect(SESSION_VOICE_INSTRUCTIONS).toContain('"doei"');
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "Mere thanks need not mean goodbye",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain(
    "finish sending that task before closing",
  );
  expect(SESSION_VOICE_INSTRUCTIONS).toContain("it does not cancel agent work");
});
