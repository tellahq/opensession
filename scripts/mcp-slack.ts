#!/usr/bin/env bun

import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

type ToolArguments = Record<string, unknown>;

type UnfurlOptions = {
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

const booleanUnfurlProperties = {
  unfurl_links: {
    type: "boolean",
    description:
      "Whether Slack should expand links in the message. Omit to use Slack's default.",
  },
  unfurl_media: {
    type: "boolean",
    description:
      "Whether Slack should expand media in the message. Omit to use Slack's default.",
  },
} as const;

/** Most files one Slack message carries through files.completeUploadExternal. */
export const MAX_MESSAGE_IMAGES = 10;

const imagesProperty = {
  images: {
    type: "array",
    items: { type: "string" },
    maxItems: MAX_MESSAGE_IMAGES,
    description:
      "Optional absolute paths of images (a PNG chart, a screenshot) to attach to this message, posted immediately with no review. Only files inside /tmp/slack-uploads are accepted: copy them there first (mkdir -p /tmp/slack-uploads). When the person should review the post first, use compose_message instead.",
  },
} as const;

export const tools = [
  {
    name: "slack_list_channels",
    description:
      "List public or pre-defined channels in the workspace with pagination",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description:
            "Maximum number of channels to return (default 100, max 200)",
          default: 100,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor for next page of results",
        },
      },
    },
  },
  {
    name: "slack_post_message",
    description:
      "Post a new message to a Slack channel right away, with optional image attachments (images). Use it only when posting without review is intended.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "The ID of the channel to post to",
        },
        text: { type: "string", description: "The message text to post" },
        ...imagesProperty,
        ...booleanUnfurlProperties,
      },
      required: ["channel_id", "text"],
    },
  },
  {
    name: "slack_reply_to_thread",
    description:
      "Reply to a specific message thread in Slack, with optional image attachments (images).",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "The ID of the channel containing the thread",
        },
        thread_ts: {
          type: "string",
          description: "The timestamp of the parent message",
        },
        text: { type: "string", description: "The reply text" },
        ...imagesProperty,
        ...booleanUnfurlProperties,
      },
      required: ["channel_id", "thread_ts", "text"],
    },
  },
  {
    name: "slack_upload_file",
    description:
      "Upload a local file (image, video, PDF, log, ...) and share it in a channel, or in a thread when thread_ts is given. Only files inside /tmp/slack-uploads are accepted: copy the file there first (mkdir -p /tmp/slack-uploads). At most 1 GB.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "The ID of the channel to share the file in",
        },
        thread_ts: {
          type: "string",
          description:
            "Timestamp of the parent message to share the file as a thread reply",
        },
        path: {
          type: "string",
          description: "Absolute path of the file to upload",
        },
        title: {
          type: "string",
          description: "Title shown on the file. Defaults to the filename",
        },
        initial_comment: {
          type: "string",
          description: "Message text posted together with the file",
        },
      },
      required: ["channel_id", "path"],
    },
  },
  {
    name: "slack_add_reaction",
    description: "Add a reaction emoji to a message",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "The ID of the channel containing the message",
        },
        timestamp: {
          type: "string",
          description: "The timestamp of the message to react to",
        },
        reaction: {
          type: "string",
          description: "The emoji name without colons",
        },
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
        limit: {
          type: "number",
          description: "Number of messages to retrieve (default 10)",
          default: 10,
        },
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
        channel_id: {
          type: "string",
          description: "The ID of the channel containing the thread",
        },
        thread_ts: {
          type: "string",
          description: "The timestamp of the parent message",
        },
      },
      required: ["channel_id", "thread_ts"],
    },
  },
  {
    name: "slack_get_users",
    description:
      "Get a list of all users in the workspace with their basic profile information",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description: "Pagination cursor for next page of results",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of users to return (default 100, max 200)",
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
  if (typeof value !== "string" || !value)
    throw new Error(`Missing required argument: ${name}`);
  return value;
}

function optionalString(args: ToolArguments, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalStrings(args: ToolArguments, name: string): string[] {
  const value = args[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be an array of file paths`);
  const paths = [...new Set(value as string[])];
  if (paths.length > MAX_MESSAGE_IMAGES)
    throw new Error(`${name} takes at most ${MAX_MESSAGE_IMAGES} files`);
  return paths;
}

function optionalBoolean(
  args: ToolArguments,
  name: string,
): boolean | undefined {
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
    ...(options.unfurl_links !== undefined
      ? { unfurl_links: options.unfurl_links }
      : {}),
    ...(options.unfurl_media !== undefined
      ? { unfurl_media: options.unfurl_media }
      : {}),
  };
}

/** Slack's own per-file limit for external uploads. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/**
 * The only directory uploads may come from. This process can read everything
 * the service user can, including credentials, so an agent must place the
 * file here itself rather than naming an arbitrary path.
 */
export const UPLOAD_ROOT = "/tmp/slack-uploads";

/** Resolve an upload path, allowing only regular files inside `root`. */
export async function resolveUploadFile(
  path: string,
  root = UPLOAD_ROOT,
): Promise<{ path: string; size: number }> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    throw new Error(`File not found: ${path}`);
  }
  const allowed = await realpath(root).catch(() => undefined);
  if (!allowed || !resolved.startsWith(`${allowed}/`))
    throw new Error(`File must be inside ${root}: ${path}`);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
  if (!info.size || info.size > MAX_UPLOAD_BYTES)
    throw new Error(`File must be between 1 byte and 1 GB: ${path}`);
  return { path: resolved, size: info.size };
}

export type UploadOptions = {
  threadTs?: string;
  title?: string;
  initialComment?: string;
};

function slackError(step: string, result: any): Error {
  if (result?.error === "missing_scope")
    return new Error(
      `Slack ${step} failed: the bot token is missing the ${result.needed || "files:write"} scope. Add it to the Slack app and reinstall it.`,
    );
  return new Error(
    `Slack ${step} failed: ${result?.error || "invalid response"}`,
  );
}

export class SlackClient {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly botToken: string,
    private readonly uploadRoot = UPLOAD_ROOT,
  ) {
    this.headers = {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    };
  }

  private async get(path: string, params: URLSearchParams): Promise<unknown> {
    const response = await fetch(`https://slack.com/api/${path}?${params}`, {
      headers: this.headers,
    });
    return response.json();
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
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
        const result = (await this.get(
          "conversations.info",
          new URLSearchParams({ channel }),
        )) as any;
        if (result.ok && result.channel && !result.channel.is_archived)
          channels.push(result.channel);
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

  postMessage(
    channel: string,
    text: string,
    options: UnfurlOptions,
  ): Promise<unknown> {
    return this.post(
      "chat.postMessage",
      buildSlackMessageBody(channel, text, options),
    );
  }

  postReply(
    channel: string,
    threadTs: string,
    text: string,
    options: UnfurlOptions,
  ): Promise<unknown> {
    return this.post(
      "chat.postMessage",
      buildSlackMessageBody(channel, text, options, threadTs),
    );
  }

  private async postForm(
    path: string,
    params: Record<string, string>,
  ): Promise<any> {
    const response = await fetch(`https://slack.com/api/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(params),
    });
    return response.json();
  }

  /** Reserve an upload URL for one file and send its bytes there. */
  private async reserveAndSend(path: string): Promise<string> {
    const file = await resolveUploadFile(path, this.uploadRoot);
    const reserved = await this.postForm("files.getUploadURLExternal", {
      filename: basename(file.path),
      length: String(file.size),
    });
    if (!reserved?.ok || !reserved.upload_url || !reserved.file_id)
      throw slackError("upload reservation", reserved);

    const uploaded = await fetch(reserved.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Bun.file(file.path),
    });
    if (!uploaded.ok)
      throw new Error(`Slack file upload failed: HTTP ${uploaded.status}`);
    return reserved.file_id;
  }

  /**
   * Slack retired files.upload; external uploads reserve a URL, receive the
   * bytes there, and are shared by files.completeUploadExternal. Every file
   * is checked before any byte leaves, so a bad path uploads nothing.
   */
  private async shareFiles(
    channel: string,
    paths: string[],
    options: UploadOptions,
  ): Promise<Array<{ id: string; title: string }>> {
    for (const path of paths) await resolveUploadFile(path, this.uploadRoot);
    const files = [];
    for (const path of paths) {
      files.push({
        id: await this.reserveAndSend(path),
        title: (paths.length === 1 && options.title) || basename(path),
      });
    }
    const completed = await this.postForm("files.completeUploadExternal", {
      files: JSON.stringify(files),
      channel_id: channel,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
      ...(options.initialComment
        ? { initial_comment: options.initialComment }
        : {}),
    });
    if (!completed?.ok) throw slackError("upload completion", completed);
    return files;
  }

  async uploadFile(
    channel: string,
    path: string,
    options: UploadOptions = {},
  ): Promise<unknown> {
    const [file] = await this.shareFiles(channel, [path], options);
    const info = (await this.get(
      "files.info",
      new URLSearchParams({ file: file!.id }),
    ).catch(() => undefined)) as any;
    return {
      ok: true,
      file_id: file!.id,
      title: file!.title,
      ...(info?.file?.permalink ? { permalink: info.file.permalink } : {}),
    };
  }

  /**
   * The message Slack shared `fileId` in. completeUploadExternal answers
   * without it, and files.info would need files:read, which the generated
   * manifest does not grant, so the message is found in the conversation the
   * upload went to, with the history scopes the bot already has.
   */
  private async findFileMessage(
    channel: string,
    fileId: string,
    since: number,
    threadTs?: string,
  ): Promise<{ ts?: string; error?: string }> {
    const params = new URLSearchParams({
      channel,
      oldest: since.toFixed(6),
      limit: "50",
    });
    if (threadTs) params.set("ts", threadTs);
    const found = (await this.get(
      threadTs ? "conversations.replies" : "conversations.history",
      params,
    ).catch(() => undefined)) as any;
    if (!found?.ok) return { error: found?.error || "invalid response" };
    const message = (found.messages ?? []).find((candidate: any) =>
      (candidate?.files ?? []).some((file: any) => file?.id === fileId),
    );
    return { ts: typeof message?.ts === "string" ? message.ts : undefined };
  }

  /**
   * One message carrying `text` and the images, answered like
   * chat.postMessage (`ok`, `channel`, `ts` first) so callers that link a
   * post to its thread read an image post the same way. Slack shares an
   * upload asynchronously, so the message is looked up with a short, bounded
   * retry. The post has already succeeded by then, so a lookup that fails
   * says why in `warning` rather than failing the call.
   */
  async postWithImages(
    channel: string,
    text: string,
    images: string[],
    threadTs?: string,
    shareWaitMs = 500,
  ): Promise<unknown> {
    // A second of slack for clock skew between this host and Slack.
    const since = Date.now() / 1000 - 1;
    const files = await this.shareFiles(channel, images, {
      threadTs,
      initialComment: text,
    });
    let ts: string | undefined;
    let error: string | undefined;
    for (let attempt = 0; attempt < 6 && !ts && !error; attempt++) {
      if (attempt > 0) await Bun.sleep(shareWaitMs);
      ({ ts, error } = await this.findFileMessage(
        channel,
        files[0]!.id,
        since,
        threadTs,
      ));
    }
    let permalink: string | undefined;
    if (ts) {
      const link = (await this.get(
        "chat.getPermalink",
        new URLSearchParams({ channel, message_ts: ts }),
      ).catch(() => undefined)) as any;
      if (typeof link?.permalink === "string") permalink = link.permalink;
    }
    const warning = ts
      ? undefined
      : error === "missing_scope"
        ? `Posted, but the message could not be looked up: the bot token is missing history scope for this conversation (channels:history, groups:history, im:history or mpim:history).`
        : `Posted, but the message could not be looked up${error ? `: ${error}` : " yet"}.`;
    return {
      ok: true,
      channel,
      ...(ts ? { ts } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(permalink ? { permalink } : {}),
      files: files.map((file) => file.id),
      ...(warning ? { warning } : {}),
    };
  }

  addReaction(
    channel: string,
    timestamp: string,
    reaction: string,
  ): Promise<unknown> {
    return this.post("reactions.add", { channel, timestamp, name: reaction });
  }

  channelHistory(channel: string, limit = 10): Promise<unknown> {
    return this.get(
      "conversations.history",
      new URLSearchParams({ channel, limit: String(limit) }),
    );
  }

  threadReplies(channel: string, threadTs: string): Promise<unknown> {
    return this.get(
      "conversations.replies",
      new URLSearchParams({ channel, ts: threadTs }),
    );
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
    return this.get(
      "users.profile.get",
      new URLSearchParams({ user, include_labels: "true" }),
    );
  }
}

async function main(): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const teamId = process.env.SLACK_TEAM_ID;
  if (!botToken || !teamId)
    throw new Error("SLACK_BOT_TOKEN and SLACK_TEAM_ID are required");

  const client = new SlackClient(botToken);
  const server = new Server(
    { name: "opensession-slack", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools],
  }));
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
          result = await client.listChannels(
            args.limit as number | undefined,
            args.cursor as string | undefined,
          );
          break;
        case "slack_post_message": {
          const images = optionalStrings(args, "images");
          result = images.length
            ? await client.postWithImages(
                requiredString(args, "channel_id"),
                requiredString(args, "text"),
                images,
              )
            : await client.postMessage(
                requiredString(args, "channel_id"),
                requiredString(args, "text"),
                options,
              );
          break;
        }
        case "slack_reply_to_thread": {
          const images = optionalStrings(args, "images");
          result = images.length
            ? await client.postWithImages(
                requiredString(args, "channel_id"),
                requiredString(args, "text"),
                images,
                requiredString(args, "thread_ts"),
              )
            : await client.postReply(
                requiredString(args, "channel_id"),
                requiredString(args, "thread_ts"),
                requiredString(args, "text"),
                options,
              );
          break;
        }
        case "slack_upload_file":
          result = await client.uploadFile(
            requiredString(args, "channel_id"),
            requiredString(args, "path"),
            {
              threadTs: optionalString(args, "thread_ts"),
              title: optionalString(args, "title"),
              initialComment: optionalString(args, "initial_comment"),
            },
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
          result = await client.channelHistory(
            requiredString(args, "channel_id"),
            args.limit as number | undefined,
          );
          break;
        case "slack_get_thread_replies":
          result = await client.threadReplies(
            requiredString(args, "channel_id"),
            requiredString(args, "thread_ts"),
          );
          break;
        case "slack_get_users":
          result = await client.users(
            args.limit as number | undefined,
            args.cursor as string | undefined,
          );
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
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
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
