import { describe, expect, test } from "bun:test";
import {
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  buildSlackManifest,
  slackCreateAppUrl,
  slackManifestJson,
} from "./slack-manifest";

const base = {
  publicBaseUrl: "https://os.example.ts.net",
  webhookBaseUrl: "https://hooks.example.ts.net",
  appName: "Open Session",
};

describe("buildSlackManifest", () => {
  test("carries both request URLs and leaves Socket Mode off", () => {
    // The server only implements HTTP intake (agents/slack/index.ts always
    // registers /slack/events and /slack/actions), so a manifest without
    // request URLs would create an app that can never reach it.
    const manifest = buildSlackManifest(base);
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://hooks.example.ts.net/slack/events",
    );
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
    expect(manifest.settings.interactivity.request_url).toBe(
      "https://hooks.example.ts.net/slack/actions",
    );
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });

  test("a trailing slash on the base URL does not double up", () => {
    const manifest = buildSlackManifest({
      ...base,
      webhookBaseUrl: "https://hooks.example.ts.net/",
    });
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://hooks.example.ts.net/slack/events",
    );
  });

  test("scopes and events match the documented sets", () => {
    const manifest = buildSlackManifest(base);
    expect(manifest.oauth_config.scopes.bot).toEqual(SLACK_BOT_SCOPES);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      SLACK_BOT_EVENTS,
    );
    // The agent uploads merged visual-change screenshots, so file writing is
    // load-bearing — the dialog used to claim no file scope was needed.
    expect(SLACK_BOT_SCOPES).toContain("files:write");
    expect(SLACK_BOT_SCOPES).toContain("assistant:write");
    expect(new Set(SLACK_BOT_SCOPES).size).toBe(SLACK_BOT_SCOPES.length);
  });

  test("subscribing to app mentions also grants their required scope", () => {
    expect(SLACK_BOT_EVENTS).toContain("app_mention");
    expect(SLACK_BOT_SCOPES).toContain("app_mentions:read");
  });

  test("custom workspace emoji grant their required scope", () => {
    expect(SLACK_BOT_SCOPES).toContain("emoji:read");
  });

  test("session-link unfurls include their event, scopes, and public UI domain", () => {
    const manifest = buildSlackManifest({
      ...base,
      publicBaseUrl: "https://app.example.com:8443/sessions",
    });
    expect(SLACK_BOT_EVENTS).toContain("link_shared");
    expect(SLACK_BOT_SCOPES).toContain("links:read");
    expect(SLACK_BOT_SCOPES).toContain("links:write");
    expect(manifest.features.unfurl_domains).toEqual(["app.example.com"]);
  });

  test("names are clamped to Slack's 35-character app-name limit", () => {
    const manifest = buildSlackManifest({
      ...base,
      appName: "An Extremely Long Instance Product Name That Slack Will Reject",
    });
    expect(manifest.display_information.name.length).toBeLessThanOrEqual(35);
  });

  test("a blank instance name falls back rather than producing an invalid app", () => {
    const manifest = buildSlackManifest({
      ...base,
      appName: "   ",
    });
    expect(manifest.display_information.name).toBe("Open Session");
  });
});

describe("slackCreateAppUrl", () => {
  test("round-trips the manifest through the query parameter", () => {
    const url = new URL(slackCreateAppUrl(base));
    expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    const parsed = JSON.parse(url.searchParams.get("manifest_json") || "{}");
    expect(parsed.settings.event_subscriptions.request_url).toBe(
      "https://hooks.example.ts.net/slack/events",
    );
  });
});

describe("slackManifestJson", () => {
  test("is pretty-printed, since people read and paste it by hand", () => {
    const json = slackManifestJson(base);
    expect(json).toContain("\n  ");
    expect(JSON.parse(json)).toEqual(buildSlackManifest(base));
  });
});
