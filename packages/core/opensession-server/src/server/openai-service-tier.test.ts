import { describe, expect, test } from "bun:test";
import { sessionSpeed } from "@tellahq/opensession-protocol/session";
import {
  chatgptPlanFromJwt,
  openaiServiceTier,
  supportsOpenaiUltrafast,
} from "./openai-service-tier";
import { requestedSpeed } from "./session-cache";

const jwt = (plan: string) =>
  `h.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_plan_type: plan },
    }),
  ).toString("base64url")}.s`;

describe("OpenAI service tiers", () => {
  test("offers Ultrafast on Astra and Sol only", () => {
    expect(supportsOpenaiUltrafast("pi/openai/gpt-6.2-astra")).toBe(true);
    expect(supportsOpenaiUltrafast("gpt-6.2-astra")).toBe(true);
    expect(supportsOpenaiUltrafast("pi/openai/gpt-6.2-sol")).toBe(true);
    expect(supportsOpenaiUltrafast("gpt-6.1-terra")).toBe(false);
    expect(supportsOpenaiUltrafast("gpt-6-luna")).toBe(false);
  });

  test("reads the ChatGPT plan claim", () => {
    expect(chatgptPlanFromJwt(jwt("ProMax"))).toBe("promax");
    expect(chatgptPlanFromJwt("not-a-jwt")).toBeUndefined();
    expect(chatgptPlanFromJwt(undefined)).toBeUndefined();
  });

  test("sends ultrafast only for Astra or Sol on a Pro $500 login", () => {
    const tier = (
      speed: "standard" | "fast" | "ultrafast",
      model: string,
      plan?: string,
    ) => openaiServiceTier({ speed, model, plan });
    expect(tier("ultrafast", "gpt-6.2-astra", "promax")).toBe("ultrafast");
    expect(tier("ultrafast", "gpt-6.2-astra", "pro")).toBe("priority");
    expect(tier("ultrafast", "gpt-6.2-astra")).toBe("priority");
    expect(tier("ultrafast", "gpt-6.2-sol", "promax")).toBe("ultrafast");
    expect(tier("ultrafast", "gpt-6.1-terra", "promax")).toBe("priority");
    expect(tier("fast", "gpt-6.2-astra", "promax")).toBe("priority");
    expect(tier("standard", "gpt-6.2-astra", "promax")).toBeUndefined();
  });

  test("reads legacy fastMode records as Fast", () => {
    expect(sessionSpeed({})).toBe("standard");
    expect(sessionSpeed({ fastMode: true })).toBe("fast");
    expect(sessionSpeed({ fastMode: true, speed: "ultrafast" })).toBe(
      "ultrafast",
    );
  });

  test("lets fastMode-only clients toggle Fast without dropping Ultrafast", () => {
    expect(requestedSpeed("ultrafast", false)).toBe("ultrafast");
    expect(requestedSpeed("bogus", undefined)).toBeUndefined();
    expect(requestedSpeed(undefined, true, "ultrafast")).toBe("ultrafast");
    expect(requestedSpeed(undefined, true, "standard")).toBe("fast");
    expect(requestedSpeed(undefined, false, "ultrafast")).toBe("standard");
  });
});
