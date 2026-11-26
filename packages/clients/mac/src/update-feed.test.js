const { describe, expect, test } = require("bun:test");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FEED_ASSET,
  publicFeedUrl,
  releaseFeed,
  updateFeedUrl,
} = require("./update-feed");

describe("where the app looks for updates", () => {
  test("a team server is asked for its own feed", () => {
    expect(
      updateFeedUrl({
        origin: "https://os.example.test",
        local: false,
        version: "1.2.3",
        releaseRepo: "acme/opensession",
      }),
    ).toBe(
      "https://os.example.test/api/packages/clients/mac/update?version=1.2.3",
    );
  });

  test("This Mac reads the feed its releases publish", () => {
    expect(
      updateFeedUrl({
        origin: "http://127.0.0.1:47850",
        local: true,
        version: "1.2.3",
        releaseRepo: "acme/opensession",
      }),
    ).toBe(
      `https://github.com/acme/opensession/releases/latest/download/${FEED_ASSET}`,
    );
  });

  test("a build that does not know its repository has no feed for This Mac", () => {
    for (const releaseRepo of [
      undefined,
      "",
      "acme",
      "acme/open session",
      "../x/y",
    ])
      expect(
        updateFeedUrl({
          origin: "http://127.0.0.1:47850",
          local: true,
          version: "1.2.3",
          releaseRepo,
        }),
      ).toBe(null);
    expect(publicFeedUrl("acme/opensession?x=1")).toBe(null);
    expect(
      updateFeedUrl({ origin: null, local: false, version: "1.2.3" }),
    ).toBe(null);
  });

  test("a feed served by hand wins", () => {
    expect(
      updateFeedUrl({
        origin: "https://os.example.test",
        local: true,
        version: "1.2.3",
        releaseRepo: "acme/opensession",
        override: "http://127.0.0.1:9000/feed",
      }),
    ).toBe("http://127.0.0.1:9000/feed");
  });
});

describe("the feed a release publishes", () => {
  test("names the release and its zip", () => {
    expect(
      releaseFeed({
        repo: "acme/opensession",
        tag: "v1.2.3",
        publishedAt: "2026-01-02T03:04:05Z",
      }),
    ).toEqual({
      currentRelease: "1.2.3",
      releases: [
        {
          version: "1.2.3",
          updateTo: {
            version: "1.2.3",
            name: "v1.2.3",
            pub_date: "2026-01-02T03:04:05.000Z",
            notes: "https://github.com/acme/opensession/releases/tag/v1.2.3",
            url: "https://github.com/acme/opensession/releases/download/v1.2.3/OpenSession-1.2.3-arm64.zip",
          },
        },
      ],
    });
  });

  test("is refused for anything that is not a release tag", () => {
    expect(() =>
      releaseFeed({ repo: "acme/opensession", tag: "main" }),
    ).toThrow();
    expect(() => releaseFeed({ repo: "acme", tag: "v1.2.3" })).toThrow();
  });

  test("is written by the release script", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "os1-update-feed-"));
    const out = path.join(dir, FEED_ASSET);
    childProcess.execFileSync(process.execPath, [
      path.join(__dirname, "../scripts/write-update-feed.js"),
      "acme/opensession",
      "v1.2.3",
      out,
    ]);
    const feed = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(feed.currentRelease).toBe("1.2.3");
    expect(feed.releases[0].updateTo.url).toEndWith(
      "/v1.2.3/OpenSession-1.2.3-arm64.zip",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
