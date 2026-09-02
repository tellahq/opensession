/**
 * The Slack app manifest this instance needs, generated from its own config.
 *
 * Setting Slack up by hand is the longest walk in the whole Setup page: create
 * an app, tick every bot scope one at a time, subscribe to each event type,
 * paste two request URLs, enable interactivity. Every one of those is
 * something we already know — the scopes come from the Web API methods the
 * agent calls, the URLs from the instance's own webhook base — so the person
 * should not be transcribing them.
 *
 * Slack reads all of it from a manifest. `api.slack.com/apps?new_app=1` takes
 * a `manifest_json` query parameter and opens its create-app form with the
 * manifest already filled in, which turns the walk into: click, review, create.
 *
 * The one thing a manifest CANNOT carry is a credential. Tokens and the
 * signing secret are minted after the app exists, so the guide still asks for
 * those two paste steps and nothing else.
 *
 * Keep the scope list here in sync with docs/setup/slack.md — that doc derives
 * it from the actual `slackApiCall` sites, and this is the same list as data.
 */

import type { SlackTransport } from "./slack-setup";

/** Bot token scopes, grouped by what they buy — the same grouping the setup
 *  dialog renders as copyable chips, so there is one source for both. */
export const SLACK_SCOPE_GROUPS: { label: string; items: string[] }[] = [
  {
    label: "Writing",
    items: [
      "chat:write",
      "chat:write.customize",
      "files:write",
      "reactions:write",
      "assistant:write",
    ],
  },
  {
    label: "History",
    items: ["channels:history", "groups:history", "im:history", "mpim:history"],
  },
  {
    label: "Events, links, and emoji",
    items: ["app_mentions:read", "links:read", "links:write", "emoji:read"],
  },
  {
    label: "Channels and people",
    items: [
      "channels:read",
      "groups:read",
      "im:read",
      "channels:manage",
      "groups:write",
      "channels:join",
      "im:write",
      "users:read",
    ],
  },
];

export const SLACK_BOT_SCOPES: string[] = SLACK_SCOPE_GROUPS.flatMap(
  (group) => group.items,
);

/** The events dispatchSlackEvent actually handles (agents/slack/index.ts).
 *  `message.*` is one subscription per conversation kind — the docs say
 *  "plain message events in channels", which is what these four spell. */
export const SLACK_BOT_EVENTS: string[] = [
  "app_mention",
  "assistant_thread_started",
  "link_shared",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
];

export interface SlackManifestOptions {
  /** Public UI base whose hostname Slack watches for session-link unfurls. */
  publicBaseUrl: string;
  /** Instance webhook base, e.g. https://hooks.example.com. Only used by the
   *  HTTP transport; Socket Mode never needs a reachable webhook address. */
  webhookBaseUrl: string;
  transport: SlackTransport;
  /** App and bot display name. Slack caps the app name at 35 characters and
   *  the bot display name at 80. */
  appName: string;
}

/** Slack rejects a manifest whose name is over 35 characters rather than
 *  truncating it, and an instance is free to call itself anything. */
function clampName(name: string, max: number): string {
  const trimmed = name.trim() || "Open Session";
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

function eventsUrl(webhookBaseUrl: string): string {
  return `${webhookBaseUrl.replace(/\/$/, "")}/slack/events`;
}

function actionsUrl(webhookBaseUrl: string): string {
  return `${webhookBaseUrl.replace(/\/$/, "")}/slack/actions`;
}

function publicHostname(publicBaseUrl: string): string {
  return new URL(publicBaseUrl).hostname;
}

/**
 * The manifest object. Shape follows Slack's app-manifest schema; anything we
 * do not use is left out rather than written as a default, so the generated
 * JSON reads as "what this app needs" instead of a filled-in template.
 */
export function buildSlackManifest(options: SlackManifestOptions) {
  const { publicBaseUrl, webhookBaseUrl, transport } = options;
  const appName = clampName(options.appName, 35);
  const socket = transport === "socket";
  const eventSubscriptions = socket
    ? { bot_events: SLACK_BOT_EVENTS }
    : {
        request_url: eventsUrl(webhookBaseUrl),
        bot_events: SLACK_BOT_EVENTS,
      };
  const interactivity = socket
    ? { is_enabled: true }
    : {
        is_enabled: true,
        request_url: actionsUrl(webhookBaseUrl),
      };
  return {
    display_information: {
      name: appName,
      description: `${appName} coding agent: DMs, mentions, session channels and interactive controls.`,
      background_color: "#4a154b",
    },
    features: {
      unfurl_domains: [publicHostname(publicBaseUrl)],
      bot_user: {
        display_name: clampName(appName, 80),
        always_online: true,
      },
      // The agent calls assistant.threads.setStatus / setSuggestedPrompts,
      // which Slack only accepts from an app with the assistant surface on.
      assistant_view: {
        assistant_description:
          "Ask for a change, a review, or a question about the code.",
        suggested_prompts: [],
      },
    },
    oauth_config: {
      scopes: { bot: SLACK_BOT_SCOPES },
    },
    settings: {
      event_subscriptions: eventSubscriptions,
      interactivity,
      socket_mode_enabled: socket,
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** Pretty JSON, because the person may well read it before creating the app
 *  and may paste it into Slack's own manifest box by hand. */
export function slackManifestJson(options: SlackManifestOptions): string {
  return JSON.stringify(buildSlackManifest(options), null, 2);
}

/**
 * Slack's create-app form, pre-filled. `new_app=1` opens the "Create new app"
 * dialog and `manifest_json` selects "From a manifest" with the config already
 * loaded, so the person reviews and confirms rather than transcribing.
 */
export function slackCreateAppUrl(options: SlackManifestOptions): string {
  const manifest = JSON.stringify(buildSlackManifest(options));
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifest)}`;
}
