/**
 * Guards the registry refactor: `loadAgents()` used to be a hand-written
 * if-block chain in opensession.ts, and these assertions pin the enable
 * semantics that chain had. They are deliberately about gating only — actually
 * importing the agent modules would drag in the runner and its sockets.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { activeIntegrations, isEnabled } from "./load";
import { envRequired, findIntegration, INTEGRATIONS } from "./registry";

const FLAGS = INTEGRATIONS.map((i) => i.enableFlag);
const saved = new Map(FLAGS.map((f) => [f, process.env[f]]));

afterEach(() => {
  for (const [flag, value] of saved) {
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

/** Disable everything gateable so each test starts from a known floor. */
function disableAll() {
  for (const flag of FLAGS) process.env[flag] = "false";
}

describe("integration registry", () => {
  test("boot order matches the original hand-written chain", () => {
    // Agents register webhook routes in load order; this array IS that order.
    expect(INTEGRATIONS.map((i) => i.id)).toEqual([
      "plain",
      "linear",
      "slack",
      "stripe",
      "grafana",
      "github",
      "codestorage",
    ]);
  });

  test("every integration declares an id, flag and doc", () => {
    for (const spec of INTEGRATIONS) {
      expect(spec.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(spec.enableFlag).toMatch(/^ENABLE_[A-Z_]+$/);
      expect(spec.doc.length).toBeGreaterThan(0);
    }
  });

  test("enable flags are unique", () => {
    expect(new Set(FLAGS).size).toBe(FLAGS.length);
  });
});

describe("isEnabled", () => {
  test("only the literal string 'true' enables via env", () => {
    const slack = findIntegration("slack")!;
    process.env.ENABLE_SLACK_AGENT = "true";
    expect(isEnabled(slack)).toBe(true);

    // Long-standing asymmetry: "1" does NOT enable. Onboarding writes explicit
    // values rather than relying on this.
    for (const value of ["false", "0", "1", "yes", ""]) {
      process.env.ENABLE_SLACK_AGENT = value;
      expect(isEnabled(slack)).toBe(false);
    }
  });
});

describe("activeIntegrations", () => {
  test("nothing loads with everything disabled", () => {
    disableAll();
    // No `always: true` modules remain in the registry; the mechanism stays
    // for future self-gating modules.
    expect(activeIntegrations().map((i) => i.id)).toEqual([]);
  });

  test("stripe stays out without its webhook secret", () => {
    disableAll();
    process.env.ENABLE_STRIPE_AGENT = "true";
    expect(activeIntegrations().map((i) => i.id)).not.toContain("stripe");

    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    expect(activeIntegrations().map((i) => i.id)).toContain("stripe");
  });

  test("enabled integrations keep registry order", () => {
    disableAll();
    process.env.ENABLE_GITHUB_AGENT = "true";
    process.env.ENABLE_PLAIN_AGENT = "true";
    expect(activeIntegrations().map((i) => i.id)).toEqual(["plain", "github"]);
  });
});

describe("envRequired", () => {
  const slack = findIntegration("slack")!;
  const signingSecret = slack.env.find(
    (e) => e.name === "SLACK_SIGNING_SECRET",
  )!;
  const botToken = slack.env.find((e) => e.name === "SLACK_BOT_TOKEN")!;

  test("Socket Mode does not require the HTTP signing secret", () => {
    expect(
      envRequired(signingSecret, (name) => name === "SLACK_APP_TOKEN"),
    ).toBe(false);
  });

  test("the HTTP transport requires its signing secret", () => {
    expect(envRequired(signingSecret, () => false)).toBe(true);
  });

  test("unconditional credentials stay required", () => {
    expect(envRequired(botToken, () => true)).toBe(true);
    expect(envRequired(botToken, () => false)).toBe(true);
  });
});
