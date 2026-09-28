import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSlackMessageBody,
  resolveUploadFile,
  SlackClient,
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

  test("accepts a file under the home directory", async () => {
    const path = join(home, "clip.mp4");
    await writeFile(path, "video");

    expect(await resolveUploadFile(path, await realpath(home))).toEqual({
      path: await realpath(path),
      size: 5,
    });
  });

  test("rejects files outside /tmp and the home directory", async () => {
    await expect(
      resolveUploadFile("/etc/hostname", "/nonexistent-home"),
    ).rejects.toThrow("must be under /tmp");
  });

  test("rejects a symlink that points outside the allowed roots", async () => {
    const link = join(home, "escape");
    await symlink("/etc/hostname", link);

    await expect(resolveUploadFile(link, await realpath(home))).rejects.toThrow(
      "must be under /tmp",
    );
  });

  test("rejects directories, empty files and missing paths", async () => {
    const empty = join(dir, "empty.mp4");
    await writeFile(empty, "");

    const root = await realpath(dir);

    await expect(resolveUploadFile(empty, root)).rejects.toThrow(
      "between 1 byte",
    );
    await expect(
      resolveUploadFile(home, await realpath(tmpdir())),
    ).rejects.toThrow("Not a regular file");
    await expect(resolveUploadFile(join(dir, "nope"), root)).rejects.toThrow(
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

    const result = await new SlackClient("xoxb-test").uploadFile("C1", path, {
      threadTs: "123.456",
      initialComment: "before/after",
    });

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
      new SlackClient("xoxb-test").uploadFile("C1", path),
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
      new SlackClient("xoxb-test").uploadFile("C1", path),
    ).rejects.toThrow("upload completion failed: not_in_channel");
  });
});
