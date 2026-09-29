import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlackPostScanner } from "../packages/core/opensession-server/src/server/slack-links";
import {
  buildSlackMessageBody,
  resolveUploadFile,
  SlackClient,
  tools,
} from "./mcp-slack";

describe("buildSlackMessageBody", () => {
  test("uses Slack defaults when unfurl options are omitted", () => {
    expect(buildSlackMessageBody("C123", "hello")).toEqual({
      channel: "C123",
      text: "hello",
    });
  });

  test("passes explicit unfurl options and thread timestamp", () => {
    expect(
      buildSlackMessageBody(
        "C123",
        "hello",
        { unfurl_links: false, unfurl_media: false },
        "123.456",
      ),
    ).toEqual({
      channel: "C123",
      text: "hello",
      thread_ts: "123.456",
      unfurl_links: false,
      unfurl_media: false,
    });
  });
});

describe("resolveUploadFile", () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-slack-"));
    home = await mkdtemp(join(tmpdir(), "mcp-slack-home-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test("accepts a file inside the upload root", async () => {
    const path = join(home, "clip.mp4");
    await writeFile(path, "video");

    expect(await resolveUploadFile(path, home)).toEqual({
      path: await realpath(path),
      size: 5,
    });
  });

  test("rejects files outside the upload root", async () => {
    const sibling = join(dir, "secret.json");
    await writeFile(sibling, "token");

    await expect(resolveUploadFile(sibling, home)).rejects.toThrow(
      "must be inside",
    );
    await expect(resolveUploadFile("/etc/hostname", home)).rejects.toThrow(
      "must be inside",
    );
  });

  test("rejects a symlink that points outside the allowed roots", async () => {
    const link = join(home, "escape");
    await symlink("/etc/hostname", link);

    await expect(resolveUploadFile(link, home)).rejects.toThrow(
      "must be inside",
    );
  });

  test("rejects directories, empty files and missing paths", async () => {
    const empty = join(dir, "empty.mp4");
    await writeFile(empty, "");

    await expect(resolveUploadFile(empty, dir)).rejects.toThrow(
      "between 1 byte",
    );
    await expect(resolveUploadFile(home, tmpdir())).rejects.toThrow(
      "Not a regular file",
    );
    await expect(resolveUploadFile(join(dir, "nope"), dir)).rejects.toThrow(
      "File not found",
    );
  });
});

describe("SlackClient.uploadFile", () => {
  const originalFetch = globalThis.fetch;
  let dir: string;
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-slack-"));
    calls = [];
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  });

  function mockSlack(responses: Record<string, unknown>) {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const key = Object.keys(responses).find((part) => url.includes(part));
      if (!key) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify(responses[key]), { status: 200 });
    }) as typeof fetch;
  }

  test("reserves, uploads the bytes, and shares into the thread", async () => {
    const path = join(dir, "clip.mp4");
    await writeFile(path, "video-bytes");
    mockSlack({
      "files.getUploadURLExternal": {
        ok: true,
        upload_url: "https://files.example.test/upload/1",
        file_id: "F1",
      },
      "files.example.test": { ok: true },
      "files.completeUploadExternal": { ok: true, files: [{ id: "F1" }] },
      "files.info": {
        ok: true,
        file: { permalink: "https://acme.example.test/files/F1" },
      },
    });

    const result = await new SlackClient("xoxb-test", dir).uploadFile(
      "C1",
      path,
      {
        threadTs: "123.456",
        initialComment: "before/after",
      },
    );

    expect(result).toEqual({
      ok: true,
      file_id: "F1",
      title: "clip.mp4",
      permalink: "https://acme.example.test/files/F1",
    });
    const reserve = new URLSearchParams(String(calls[0]!.init!.body));
    expect(reserve.get("filename")).toBe("clip.mp4");
    expect(reserve.get("length")).toBe("11");
    expect(calls[1]!.url).toBe("https://files.example.test/upload/1");
    expect(await new Response(calls[1]!.init!.body).text()).toBe("video-bytes");
    const complete = new URLSearchParams(String(calls[2]!.init!.body));
    expect(complete.get("channel_id")).toBe("C1");
    expect(complete.get("thread_ts")).toBe("123.456");
    expect(complete.get("initial_comment")).toBe("before/after");
    expect(JSON.parse(complete.get("files")!)).toEqual([
      { id: "F1", title: "clip.mp4" },
    ]);
  });

  test("names the missing files:write scope", async () => {
    const path = join(dir, "clip.mp4");
    await writeFile(path, "video");
    mockSlack({
      "files.getUploadURLExternal": {
        ok: false,
        error: "missing_scope",
        needed: "files:write",
      },
    });

    await expect(
      new SlackClient("xoxb-test", dir).uploadFile("C1", path),
    ).rejects.toThrow("missing the files:write scope");
  });

  test("fails when Slack rejects the completion", async () => {
    const path = join(dir, "clip.mp4");
    await writeFile(path, "video");
    mockSlack({
      "files.getUploadURLExternal": {
        ok: true,
        upload_url: "https://files.example.test/upload/1",
        file_id: "F1",
      },
      "files.example.test": { ok: true },
      "files.completeUploadExternal": { ok: false, error: "not_in_channel" },
    });

    await expect(
      new SlackClient("xoxb-test", dir).uploadFile("C1", path),
    ).rejects.toThrow("upload completion failed: not_in_channel");
  });
});

describe("posting with images", () => {
  const originalFetch = globalThis.fetch;
  let dir: string;
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-slack-"));
    calls = [];
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Slack with only the documented bot scopes: files.info is refused for want
   * of files:read, and the shared message appears in history only on the
   * `shareAfter`th lookup, as Slack shares an upload asynchronously.
   */
  function mockSlack(shareAfter = 1, historyError?: string) {
    let reserved = 0;
    let lookups = 0;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("files.getUploadURLExternal")) {
        reserved += 1;
        return json({
          ok: true,
          upload_url: `https://files.example.test/upload/${reserved}`,
          file_id: `F${reserved}`,
        });
      }
      if (url.includes("files.example.test")) return json({ ok: true });
      if (url.includes("files.completeUploadExternal"))
        return json({ ok: true, files: [{ id: "F1" }, { id: "F2" }] });
      if (url.includes("files.info"))
        return json({
          ok: false,
          error: "missing_scope",
          needed: "files:read",
        });
      if (
        url.includes("conversations.history") ||
        url.includes("conversations.replies")
      ) {
        if (historyError) return json({ ok: false, error: historyError });
        lookups += 1;
        return json({
          ok: true,
          messages:
            lookups >= shareAfter
              ? [
                  { ts: "1700000000.000050", text: "someone else" },
                  {
                    ts: "1700000000.000100",
                    files: [{ id: "F1" }, { id: "F2" }],
                  },
                ]
              : [{ ts: "1700000000.000050", text: "someone else" }],
        });
      }
      if (url.includes("chat.getPermalink"))
        return json({
          ok: true,
          permalink: "https://acme.example.test/archives/C1/p1",
        });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  test("slack_post_message and slack_reply_to_thread advertise images", () => {
    for (const name of ["slack_post_message", "slack_reply_to_thread"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(Object.keys(tool.inputSchema.properties)).toContain("images");
      expect(tool.description).toContain("image");
    }
  });

  test("shares every image in one message with the text", async () => {
    const chart = join(dir, "chart.png");
    const table = join(dir, "table.png");
    await writeFile(chart, "png-1");
    await writeFile(table, "png-2");
    mockSlack(2);

    const result = await new SlackClient("xoxb-test", dir).postWithImages(
      "C1",
      "Latency after the deploy",
      [chart, table],
      undefined,
      0,
    );

    expect(result).toEqual({
      ok: true,
      channel: "C1",
      ts: "1700000000.000100",
      permalink: "https://acme.example.test/archives/C1/p1",
      files: ["F1", "F2"],
    });
    const completions = calls.filter((call) =>
      call.url.includes("files.completeUploadExternal"),
    );
    expect(completions).toHaveLength(1);
    const complete = new URLSearchParams(String(completions[0]!.init!.body));
    expect(complete.get("channel_id")).toBe("C1");
    expect(complete.get("initial_comment")).toBe("Latency after the deploy");
    expect(complete.get("thread_ts")).toBeNull();
    expect(JSON.parse(complete.get("files")!)).toEqual([
      { id: "F1", title: "chart.png" },
      { id: "F2", title: "table.png" },
    ]);
    expect(calls.some((call) => call.url.includes("chat.postMessage"))).toBe(
      false,
    );
    // Found with the history scope, not files.info (which needs files:read).
    expect(calls.some((call) => call.url.includes("files.info"))).toBe(false);
    const lookup = new URL(
      calls.find((call) => call.url.includes("conversations.history"))!.url,
    );
    expect(lookup.searchParams.get("channel")).toBe("C1");
    expect(Number(lookup.searchParams.get("oldest"))).toBeGreaterThan(0);
  });

  test("says why when the message cannot be looked up", async () => {
    const chart = join(dir, "chart.png");
    await writeFile(chart, "png");
    mockSlack(1, "missing_scope");

    const result = (await new SlackClient("xoxb-test", dir).postWithImages(
      "C1",
      "Chart",
      [chart],
      undefined,
      0,
    )) as any;

    expect(result.ok).toBe(true);
    expect(result.ts).toBeUndefined();
    expect(result.warning).toContain("history scope");
    // A refused scope does not get better by asking again.
    expect(
      calls.filter((call) => call.url.includes("conversations.history")),
    ).toHaveLength(1);
  });

  test("links an image post to its thread like a text post", async () => {
    const chart = join(dir, "chart.png");
    await writeFile(chart, "png");
    mockSlack();
    const result = await new SlackClient("xoxb-test", dir).postWithImages(
      "C1",
      "Chart",
      [chart],
      undefined,
      0,
    );
    const scan = createSlackPostScanner();
    scan({
      type: "tool_use",
      toolUseId: "t1",
      toolName: "mcp_call",
      toolInput: {
        name: "slack_slack_post_message",
        arguments: { channel_id: "C1", text: "Chart", images: [chart] },
      },
    });
    expect(
      scan({
        type: "tool_result",
        toolUseId: "t1",
        content: JSON.stringify(result),
      }),
    ).toEqual({ channel: "C1", threadTs: "1700000000.000100" });
  });

  test("replies into a thread", async () => {
    const chart = join(dir, "chart.png");
    await writeFile(chart, "png");
    mockSlack();

    const result = (await new SlackClient("xoxb-test", dir).postWithImages(
      "C1",
      "Chart",
      [chart],
      "123.456",
      0,
    )) as any;

    expect(result.thread_ts).toBe("123.456");
    expect(result.ts).toBe("1700000000.000100");
    const lookup = new URL(
      calls.find((call) => call.url.includes("conversations.replies"))!.url,
    );
    expect(lookup.searchParams.get("ts")).toBe("123.456");
    const complete = new URLSearchParams(
      String(
        calls.find((call) => call.url.includes("files.completeUploadExternal"))!
          .init!.body,
      ),
    );
    expect(complete.get("thread_ts")).toBe("123.456");
  });

  test("uploads nothing when any image is outside the upload root", async () => {
    const chart = join(dir, "chart.png");
    await writeFile(chart, "png");
    mockSlack();

    await expect(
      new SlackClient("xoxb-test", dir).postWithImages(
        "C1",
        "Chart",
        [chart, "/etc/hostname"],
        undefined,
        0,
      ),
    ).rejects.toThrow("must be inside");
    expect(calls).toHaveLength(0);
  });
});
