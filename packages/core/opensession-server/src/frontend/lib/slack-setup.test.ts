import { describe, expect, test } from "bun:test";
import {
  publicWebhookAvailable,
  savedSlackTransport,
  slackCredentialRequired,
} from "./slack-setup";

describe("savedSlackTransport", () => {
  test("preserves configured Socket Mode and HTTP installs", () => {
    expect(
      savedSlackTransport([{ name: "SLACK_APP_TOKEN", present: true }]),
    ).toBe("socket");
    expect(
      savedSlackTransport([{ name: "SLACK_SIGNING_SECRET", present: true }]),
    ).toBe("http");
  });

  test("prefers Socket Mode for a new install", () => {
    expect(savedSlackTransport([])).toBe("socket");
  });
});

describe("publicWebhookAvailable", () => {
  test("rejects simple-mode and loopback URLs", () => {
    for (const url of [
      "http://127.0.0.1:3850",
      "http://localhost:3850",
      "http://[::1]:3850",
      "http://0.0.0.0:3848",
      "not a url",
    ]) {
      expect(publicWebhookAvailable(url)).toBe(false);
    }
  });

  test("accepts an internet-facing webhook URL", () => {
    expect(publicWebhookAvailable("https://hooks.example.com")).toBe(true);
  });
});

describe("slackCredentialRequired", () => {
  test("follows the transport currently selected in the UI", () => {
    expect(slackCredentialRequired("SLACK_APP_TOKEN", false, "socket")).toBe(
      true,
    );
    expect(
      slackCredentialRequired("SLACK_SIGNING_SECRET", false, "socket"),
    ).toBe(false);
    expect(slackCredentialRequired("SLACK_APP_TOKEN", false, "http")).toBe(
      false,
    );
    expect(slackCredentialRequired("SLACK_SIGNING_SECRET", false, "http")).toBe(
      true,
    );
  });

  test("keeps unconditional requirements", () => {
    expect(slackCredentialRequired("SLACK_BOT_TOKEN", true, "socket")).toBe(
      true,
    );
    expect(slackCredentialRequired("SLACK_BOT_TOKEN", true, "http")).toBe(true);
  });
});
