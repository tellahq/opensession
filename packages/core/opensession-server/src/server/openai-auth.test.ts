import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CodexAccount } from "./codex-accounts";
import {
  enableOpenaiFastMode,
  buildSeededOpenaiAuth,
  supportsOpenaiFastMode,
} from "./openai-auth";

describe("OpenAI auth", () => {
  test("advertises priority-tier variants for current ChatGPT models", () => {
    expect(supportsOpenaiFastMode("pi/openai/gpt-6-astra")).toBe(true);
    expect(supportsOpenaiFastMode("pi/openai/gpt-6-sol")).toBe(true);
    expect(supportsOpenaiFastMode("openai/gpt-6-luna")).toBe(true);
    expect(supportsOpenaiFastMode("pi/openai/gpt-5.6-sol")).toBe(true);
    expect(supportsOpenaiFastMode("openai/gpt-5.6-terra")).toBe(true);
    expect(supportsOpenaiFastMode("gpt-5.6-luna")).toBe(true);
    expect(supportsOpenaiFastMode("pi/anthropic/claude-fable-5-1")).toBe(false);
  });

  test("adds the priority service tier after Pi's existing payload hook", async () => {
    const agent = {
      onPayload: async (
        payload: unknown,
      ): Promise<Record<string, unknown>> => ({
        ...(payload as Record<string, unknown>),
        existing_hook: true,
      }),
    };
    const payload = { model: "gpt-5.6-sol", stream: true };
    enableOpenaiFastMode(agent);

    expect(await agent.onPayload(payload)).toEqual({
      model: "gpt-5.6-sol",
      stream: true,
      existing_hook: true,
      service_tier: "priority",
    });
    expect(payload).toEqual({ model: "gpt-5.6-sol", stream: true });
  });
});
