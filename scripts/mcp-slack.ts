#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  postSlackFiles,
  slackUploadPermalink,
} from "../packages/core/opensession-server/src/agents/slack/slack-api";

type ToolArguments = Record<string, unknown>;

type UnfurlOptions = {
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

const booleanUnfurlProperties = {
  unfurl_links: {
    type: "boolean",
    description: "Whether Slack should expand links in the message. Omit to use Slack's default.",
  },
  unfurl_media: {
    type: "boolean",
    description: "Whether Slack should expand media in the message. Omit to use Slack's default.",
  },
} as const;

export const tools = [
  {
    name: "slack_list_channels",
    description: "List public or pre-defined channels in the workspace with pagination",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of channels to return (default 100, max 200)",
          default: 100,
        },
        cursor: { type: "string", description: "Pagination cursor for next page of results" },
      },
    },
  },
  {
    name: "slack_post_message",
    description: "Post a new message to a Slack channel",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel to post to" },
        text: { type: "string", description: "The message text to post" },
        ...booleanUnfurlProperties,
      },
      required: ["channel_id", "text"],
    },
  },
  {
    name: "slack_post_files",
    description: "Upload local files and post them to a Slack channel using the session owner's Slack identity",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel to post to" },
        file_paths: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths of local files to upload (maximum 10)",
        },
        initial_comment: { type: "string", description: "Message shown with the files" },
        title: { type: "string", description: "Optional title for the uploaded file or file set" },
        alt_text: { type: "string", description: "Optional accessible description of the files" },
        thread_ts: { type: "string", description: "Optional thread timestamp to reply under" },
      },
      required: ["channel_id", "file_paths", "initial_comment"],
    },
  },
  {
    name: "slack_reply_to_thread",
    description: "Reply to a specific message thread in Slack",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel containing the thread" },
        thread_ts: { type: "string", description: "The timestamp of the parent message" },
        text: { type: "string", description: "The reply text" },
        ...booleanUnfurlProperties,
      },
      required: ["channel_id", "thread_ts", "text"],
    },
  },
  {
    name: "slack_add_reaction",
    description: "Add a reaction emoji to a message",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel containing the message" },
        timestamp: { type: "string", description: "The timestamp of the message to react to" },
        reaction: { type: "string", description: "The emoji name without colons" },
      },
      required: ["channel_id", "timestamp", "reaction"],
    },
  },
  {
    name: "slack_get_channel_history",
    description: "Get recent messages from a channel",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel" },
        limit: { type: "number", description: "Number of messages to retrieve (default 10)", default: 10 },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "slack_get_thread_replies",
    description: "Get all replies in a message thread",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "The ID of the channel containing the thread" },
        thread_ts: { type: "string", description: "The timestamp of the parent message" },
      },
      required: ["channel_id", "thread_ts"],
    },
  },
  {
    name: "slack_get_users",
    description: "Get a list of all users in the workspace with their basic profile information",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string", description: "Pagination cursor for next page of results" },
        limit: {
          type: "number",
          description: "Maximum number of users to return (default 100, max 200)",
          default: 100,
        },
      },
    },
  },
  {
    name: "slack_get_user_profile",
    description: "Get detailed profile information for a specific user",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "The ID of the user" },
      },
      required: ["user_id"],
    },
  },
] as const;

function requiredString(args: ToolArguments, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function requiredStringArray(args: ToolArguments, name: string): string[] {
  const value = args[name];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 10 ||
    value.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error(`${name} must contain between 1 and 10 paths`);
  }
  return value;
}

export function attributedSlackText(
  text: string,
  actor = process.env.OPENSESSION_SLACK_ACTOR,
  personal = process.env.OPENSESSION_SLACK_PERSONAL === "1",
): string {
  if (personal || !actor) return text;
  return `${text}\n\nSent by ${actor} via Open Session`;
}

function optionalString(args: ToolArguments, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalBoolean(args: ToolArguments, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function buildSlackMessageBody(
  channel: string,
  text: string,
  options: UnfurlOptions = {},
  threadTs?: string,
): Record<string, string | boolean> {
  return {
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(options.unfurl_links !== undefined ? { unfurl_links: options.unfurl_links } : {}),
    ...(options.unfurl_media !== undefined ? { unfurl_media: options.unfurl_media } : {}),
  };
}

class SlackClient {
  private readonly headers: Record<string, string>;

  constructor(botToken: string) {
    this.headers = {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    };
  }

  private async get(path: string, params: URLSearchParams): Promise<unknown> {
    const response = await fetch(`https://slack.com/api/${path}?${params}`, { headers: this.headers });
    return response.json();
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`https://slack.com/api/${path}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return response.json();
  }

  async listChannels(limit = 100, cursor?: string): Promise<unknown> {
    const predefined = process.env.SLACK_CHANNEL_IDS;
    if (predefined) {
      const channels = [];
      for (const channel of predefined.split(",").map((id) => id.trim())) {
        const result = await this.get("conversations.info", new URLSearchParams({ channel })) as any;
        if (result.ok && result.channel && !result.channel.is_archived) channels.push(result.channel);
      }
      return { ok: true, channels, response_metadata: { next_cursor: "" } };
    }

    const params = new URLSearchParams({
      types: "public_channel",
      exclude_archived: "true",
      limit: String(Math.min(limit, 200)),
      team_id: process.env.SLACK_TEAM_ID!,
    });
    if (cursor) params.set("cursor", cursor);
    return this.get("conversations.list", params);
  }

  postMessage(channel: string, text: string, options: UnfurlOptions): Promise<unknown> {
    return this.post(
      "chat.postMessage",
      buildSlackMessageBody(channel, attributedSlackText(text), options),
    );
  }

  postReply(channel: string, threadTs: string, text: string, options: UnfurlOptions): Promise<unknown> {
    return this.post(
      "chat.postMessage",
      buildSlackMessageBody(channel, attributedSlackText(text), options, threadTs),
    );
  }

  addReaction(channel: string, timestamp: string, reaction: string): Promise<unknown> {
    return this.post("reactions.add", { channel, timestamp, name: reaction });
  }

  channelHistory(channel: string, limit = 10): Promise<unknown> {
    return this.get("conversations.history", new URLSearchParams({ channel, limit: String(limit) }));
  }

  threadReplies(channel: string, threadTs: string): Promise<unknown> {
    return this.get("conversations.replies", new URLSearchParams({ channel, ts: threadTs }));
  }

  users(limit = 100, cursor?: string): Promise<unknown> {
    const params = new URLSearchParams({
      limit: String(Math.min(limit, 200)),
      team_id: process.env.SLACK_TEAM_ID!,
    });
    if (cursor) params.set("cursor", cursor);
    return this.get("users.list", params);
  }

  userProfile(user: string): Promise<unknown> {
    return this.get("users.profile.get", new URLSearchParams({ user, include_labels: "true" }));
  }
}

async function main(): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const teamId = process.env.SLACK_TEAM_ID;
  if (!botToken || !teamId) throw new Error("SLACK_BOT_TOKEN and SLACK_TEAM_ID are required");

  const client = new SlackClient(botToken);
  const server = new Server(
    { name: "opensession-slack", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = (request.params.arguments ?? {}) as ToolArguments;
      const options = {
        unfurl_links: optionalBoolean(args, "unfurl_links"),
        unfurl_media: optionalBoolean(args, "unfurl_media"),
      };
      let result: unknown;

      switch (request.params.name) {
        case "slack_list_channels":
          result = await client.listChannels(args.limit as number | undefined, args.cursor as string | undefined);
          break;
        case "slack_post_message":
          result = await client.postMessage(requiredString(args, "channel_id"), requiredString(args, "text"), options);
          break;
        case "slack_post_files": {
          const channel = requiredString(args, "channel_id");
          const completed = await postSlackFiles(
            channel,
            requiredStringArray(args, "file_paths"),
            attributedSlackText(requiredString(args, "initial_comment")),
            {
              title: optionalString(args, "title"),
              altText: optionalString(args, "alt_text"),
              threadTs: optionalString(args, "thread_ts"),
            },
            botToken,
          );
          result = {
            ok: true,
            permalink: await slackUploadPermalink(completed, channel, botToken),
          };
          break;
        }
        case "slack_reply_to_thread":
          result = await client.postReply(
            requiredString(args, "channel_id"),
            requiredString(args, "thread_ts"),
            requiredString(args, "text"),
            options,
          );
          break;
        case "slack_add_reaction":
          result = await client.addReaction(
            requiredString(args, "channel_id"),
            requiredString(args, "timestamp"),
            requiredString(args, "reaction"),
          );
          break;
        case "slack_get_channel_history":
          result = await client.channelHistory(requiredString(args, "channel_id"), args.limit as number | undefined);
          break;
        case "slack_get_thread_replies":
          result = await client.threadReplies(requiredString(args, "channel_id"), requiredString(args, "thread_ts"));
          break;
        case "slack_get_users":
          result = await client.users(args.limit as number | undefined, args.cursor as string | undefined);
          break;
        case "slack_get_user_profile":
          result = await client.userProfile(requiredString(args, "user_id"));
          break;
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
