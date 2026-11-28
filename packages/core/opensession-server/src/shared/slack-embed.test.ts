import { describe, expect, test } from "bun:test";
import { embedFor, isXVideoStill } from "./slack-embed";

describe("players for previewed links", () => {
  test("YouTube in its link shapes, shorts upright, start time kept", () => {
    expect(
      embedFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s"),
    ).toEqual({
      provider: "youtube",
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&start=65",
      kind: "video",
      aspect: 16 / 9,
    });
    expect(embedFor("https://youtu.be/dQw4w9WgXcQ")?.src).toContain(
      "/embed/dQw4w9WgXcQ?",
    );
    expect(embedFor("https://youtube.com/shorts/dQw4w9WgXcQ")?.aspect).toBe(
      9 / 16,
    );
    expect(embedFor("https://www.youtube.com/watch?v=bad")).toBeUndefined();
  });

  test("Vimeo, Loom and Tella", () => {
    expect(embedFor("https://vimeo.com/76979871")?.src).toBe(
      "https://player.vimeo.com/video/76979871?autoplay=1",
    );
    expect(
      embedFor("https://www.loom.com/share/0123456789abcdef0123456789abcdef")
        ?.src,
    ).toBe(
      "https://www.loom.com/embed/0123456789abcdef0123456789abcdef?autoplay=1",
    );
    expect(embedFor("https://www.tella.com/video/vid_abc/view")?.src).toBe(
      "https://www.tella.tv/video/vid_abc/embed?b=0&autoPlay=true",
    );
    expect(
      embedFor("https://www.tella.tv/video/vid_abc/embed?feature=oembed&s=tok")
        ?.src,
    ).toBe(
      "https://www.tella.tv/video/vid_abc/embed?feature=oembed&s=tok&autoPlay=true",
    );
  });

  test("a post on X sizes itself", () => {
    expect(embedFor("https://x.com/acme/status/123456?s=46")).toEqual({
      provider: "x",
      src: "https://platform.twitter.com/embed/Tweet.html?id=123456&dnt=true",
      kind: "post",
      aspect: 1,
    });
    expect(embedFor("https://twitter.com/acme")).toBeUndefined();
  });

  test("other hosts and schemes have no player", () => {
    expect(
      embedFor("https://example.test/watch?v=dQw4w9WgXcQ"),
    ).toBeUndefined();
    expect(embedFor("javascript:alert(1)")).toBeUndefined();
    expect(embedFor(undefined)).toBeUndefined();
  });

  test("an X picture is a video's still by its path", () => {
    expect(
      isXVideoStill("https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg"),
    ).toBe(true);
    expect(isXVideoStill("https://pbs.twimg.com/media/a.jpg")).toBe(false);
  });
});
