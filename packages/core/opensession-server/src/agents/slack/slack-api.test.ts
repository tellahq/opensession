import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  postSlackBlocks,
  postSlackFiles,
  slackFileRefs,
  slackFileShareTs,
  slackUploadPermalink,
  updateSlackBlocks,
} from "./slack-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("slackFileRefs", () => {
  test("maps Slack file objects to small refs", () => {
    const refs = slackFileRefs([
      {
        id: "F123",
        name: "shot.png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.com/dl/shot.png",
        url_private: "https://files.slack.com/shot.png",
        size: 1234,
      },
    ]);
    expect(refs).toEqual([
      {
        id: "F123",
        name: "shot.png",
        mimetype: "image/png",
        url: "https://files.slack.com/dl/shot.png",
        size: 1234,
      },
    ]);
  });

  test("falls back to url_private and drops entries with no URL", () => {
    const refs = slackFileRefs([
      {
        id: "F1",
        name: "a.pdf",
        mimetype: "application/pdf",
        url_private: "https://x/a.pdf",
      },
      { id: "F2", name: "tombstone" },
      null,
    ]);
    expect(refs.map((r) => r.id)).toEqual(["F1"]);
    expect(refs[0]!.url).toBe("https://x/a.pdf");
    expect(refs[0]!.size).toBe(0);
  });

  test("handles undefined", () => {
    expect(slackFileRefs(undefined)).toEqual([]);
  });
});

describe("Slack block message options", () => {
  test("disables unfurls when posting a progress card", async () => {
    let payload: any;
    globalThis.fetch = (async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ ok: true, ts: "123.456" });
    }) as typeof fetch;

    await postSlackBlocks("C123", "fallback", [], "111.222", {
      unfurlLinks: false,
      unfurlMedia: false,
    });

    expect(payload).toMatchObject({
      channel: "C123",
      thread_ts: "111.222",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test("keeps unfurls disabled when updating a progress card", async () => {
    let payload: any;
    globalThis.fetch = (async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ ok: true });
    }) as typeof fetch;

    await updateSlackBlocks("C123", "123.456", "Working", [], {
      unfurlLinks: false,
      unfurlMedia: false,
    });

    expect(payload).toMatchObject({
      channel: "C123",
      ts: "123.456",
      unfurl_links: false,
      unfurl_media: false,
    });
  });
});

describe("slackUploadPermalink", () => {
  test("reads the share off the file when the upload response has none", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("files.info")) {
        return Response.json({
          ok: true,
          file: { shares: { public: { C123: [{ ts: "1786.42" }] } } },
        });
      }
      return Response.json({
        ok: true,
        permalink: "https://tella.slack.com/archives/C123/p178642",
      });
    }) as typeof fetch;

    // What files.completeUploadExternal actually answers: id and title only.
    const link = await slackUploadPermalink(
      { ok: true, files: [{ id: "F1", title: "Shipped" }] },
      "C123",
      "test-user-token",
    );

    expect(link).toBe("https://tella.slack.com/archives/C123/p178642");
    expect(calls.some((url) => url.includes("files.info?file=F1"))).toBe(true);
    expect(calls.some((url) => url.includes("message_ts=1786.42"))).toBe(true);
  });

  test("has no link when the file was never shared into the channel", async () => {
    globalThis.fetch = (async () =>
      Response.json({ ok: true, file: {} })) as unknown as typeof fetch;
    expect(
      await slackUploadPermalink({ files: [{ id: "F1" }] }, "C123"),
    ).toBeUndefined();
  });

  test("finds a private share, and ignores another channel's", () => {
    const file = {
      shares: {
        private: { C123: [{ ts: "1.2" }] },
        public: { C999: [{ ts: "9.9" }] },
      },
    };
    expect(slackFileShareTs(file, "C123")).toBe("1.2");
    expect(slackFileShareTs(file, "C555")).toBeUndefined();
  });
});

describe("Slack file uploads", () => {
  test("asks for reconnection when the personal token lacks image access", async () => {
    const root = mkdtempSync(join(tmpdir(), "slack-scope-"));
    const path = join(root, "one.png");
    writeFileSync(path, "image");
    globalThis.fetch = (async () =>
      Response.json({
        ok: false,
        error: "missing_scope",
      })) as unknown as typeof fetch;

    try {
      await expect(
        postSlackFiles("C123", [path], "Shipped it", {}, "test-user-token"),
      ).rejects.toThrow("SLACK_RECONNECT_REQUIRED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shares several uploaded files as one message", async () => {
    const root = mkdtempSync(join(tmpdir(), "slack-files-"));
    const paths = [join(root, "one.png"), join(root, "two.png")];
    paths.forEach((path, index) => writeFileSync(path, `image-${index}`));
    const calls: string[] = [];
    let reservation = 0;
    let completion: URLSearchParams | undefined;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("files.getUploadURLExternal")) {
        reservation++;
        return Response.json({
          ok: true,
          upload_url: `https://upload.example/${reservation}`,
          file_id: `F${reservation}`,
        });
      }
      if (url.endsWith("files.completeUploadExternal")) {
        completion = init?.body as URLSearchParams;
        return Response.json({ ok: true });
      }
      return new Response("ok");
    }) as typeof fetch;

    try {
      await postSlackFiles(
        "C123",
        paths,
        "Shipped it",
        { title: "Editor" },
        "test-user-token",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(
      calls.filter((url) => url.endsWith("files.getUploadURLExternal")),
    ).toHaveLength(2);
    expect(
      calls.filter((url) => url.endsWith("files.completeUploadExternal")),
    ).toHaveLength(1);
    expect(completion?.get("channel_id")).toBe("C123");
    expect(completion?.get("initial_comment")).toBe("Shipped it");
    expect(JSON.parse(completion?.get("files") || "[]")).toEqual([
      { id: "F1", title: "Editor 1" },
      { id: "F2", title: "Editor 2" },
    ]);
  });

  test("shares into a thread, titled by filename, with no empty comment", async () => {
    const root = mkdtempSync(join(tmpdir(), "slack-thread-"));
    const paths = [join(root, "after.png"), join(root, "demo.mp4")];
    paths.forEach((path, index) => writeFileSync(path, `media-${index}`));
    let reservation = 0;
    let completion: URLSearchParams | undefined;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("files.getUploadURLExternal")) {
        reservation++;
        return Response.json({
          ok: true,
          upload_url: `https://upload.example/${reservation}`,
          file_id: `F${reservation}`,
        });
      }
      if (url.endsWith("files.completeUploadExternal")) {
        completion = init?.body as URLSearchParams;
        return Response.json({ ok: true });
      }
      return new Response("ok");
    }) as typeof fetch;

    try {
      await postSlackFiles(
        "C123",
        paths,
        "",
        { threadTs: "1712.9" },
        "test-user-token",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(completion?.get("thread_ts")).toBe("1712.9");
    expect(completion?.has("initial_comment")).toBe(false);
    expect(JSON.parse(completion?.get("files") || "[]")).toEqual([
      { id: "F1", title: "after.png" },
      { id: "F2", title: "demo.mp4" },
    ]);
  });
});
