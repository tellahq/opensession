/** Pure ChatGPT service-tier rules: which models take Fast and Ultrafast,
 * and which plan may send Ultrafast. No account or filesystem access, so the
 * Pi runtime binding can import it without loading the account store. */
import type { SessionSpeed } from "@tellahq/opensession-protocol/session";

const OPENAI_FAST_MODE_MODELS = new Set([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

function openaiSlug(model: string): string {
  return model.replace(/^pi\/openai\//, "").replace(/^openai\//, "");
}

/** ChatGPT subscription models whose backend accepts the priority service tier. */
export function supportsOpenaiFastMode(model?: string): boolean {
  return !!model && OPENAI_FAST_MODE_MODELS.has(openaiSlug(model));
}

// https://learn.chatgpt.com/docs/agent-configuration/speed#astra-ultrafast
const OPENAI_ULTRAFAST_MODELS = new Set(["gpt-6-astra"]);

/** Models the ChatGPT backend serves on the ultrafast service tier. */
export function supportsOpenaiUltrafast(model?: string): boolean {
  return !!model && OPENAI_ULTRAFAST_MODELS.has(openaiSlug(model));
}

/** The only self-serve ChatGPT plan with ultrafast access: Pro $500. Codex
 * names it "promax"; the $200 plan is "pro" and the $100 plan "prolite". */
export const ULTRAFAST_CHATGPT_PLAN = "promax";

/** The ChatGPT plan claim in an access or ID token, lowercased. */
export function chatgptPlanFromJwt(jwt: unknown): string | undefined {
  if (typeof jwt !== "string") return undefined;
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8"),
    );
    const plan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
    return typeof plan === "string" && plan ? plan.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export type OpenaiServiceTier = "priority" | "ultrafast";

/** Service tier for a ChatGPT OAuth turn at the session's speed. Ultrafast
 * needs GPT-6 Astra and a Pro $500 login; short of either it runs as Fast. */
export function openaiServiceTier(input: {
  speed: SessionSpeed;
  model: string;
  plan?: string;
}): OpenaiServiceTier | undefined {
  if (input.speed === "standard") return undefined;
  return input.speed === "ultrafast" &&
    supportsOpenaiUltrafast(input.model) &&
    input.plan === ULTRAFAST_CHATGPT_PLAN
    ? "ultrafast"
    : "priority";
}
