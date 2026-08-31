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
  test("HTTP transport carries both request URLs", () => {
    const manifest = buildSlackManifest({ ...base, transport: "http" });
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://hooks.example.ts.net/slack/events",
    );
    expect(manifest.settings.interactivity.request_url).toBe(
      "https://hooks.example.ts.net/slack/actions",
    );
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });

  test("Socket Mode omits request URLs entirely", () => {
    // A Socket Mode instance may have no reachable address at all, so a URL
    // here would be a promise the deployment cannot keep.
    const manifest = buildSlackManifest({
      ...base,
      transport: "socket",
    });
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.request_url).toBeUndefined();
    expect(manifest.settings.interactivity.request_url).toBeUndefined();
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
  });

  test("a trailing slash on the base URL does not double up", () => {
    const manifest = buildSlackManifest({
      ...base,
      webhookBaseUrl: "https://hooks.example.ts.net/",
      transport: "http",
    });
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://hooks.example.ts.net/slack/events",
    );
  });

  test("scopes and events match the documented sets", () => {
    const manifest = buildSlackManifest({ ...base, transport: "http" });
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
      transport: "socket",
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
      transport: "socket",
    });
    expect(manifest.display_information.name.length).toBeLessThanOrEqual(35);
  });

  test("a blank instance name falls back rather than producing an invalid app", () => {
    const manifest = buildSlackManifest({
      ...base,
      appName: "   ",
      transport: "socket",
    });
    expect(manifest.display_information.name).toBe("Open Session");
  });
});

describe("slackCreateAppUrl", () => {
  test("round-trips the manifest through the query parameter", () => {
    const url = new URL(slackCreateAppUrl({ ...base, transport: "http" }));
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
    const json = slackManifestJson({ ...base, transport: "socket" });
    expect(json).toContain("\n  ");
    expect(JSON.parse(json)).toEqual(
      buildSlackManifest({ ...base, transport: "socket" }),
    );
  });
});
