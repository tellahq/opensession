import { describe, expect, it } from "bun:test";
import { placedMediaSrcs, unplacedMedia } from "./placed-media";

const shot = "/media?path=%2Ftmp%2Fshot.png";
const clip = "/media?path=%2Ftmp%2Fclip.mp4";
const before = "/media?path=%2Ftmp%2Fbefore.png";
const after = "/media?path=%2Ftmp%2Fafter.png";

describe("placedMediaSrcs", () => {
  it("finds placed images, videos and both halves of a compare fence", () => {
    const content = [
      "## Proof",
      "",
      `![The login page](${shot})`,
      "",
      `![](${clip})`,
      "",
      "```compare",
      `before: ${before}`,
      `after: ${after}`,
      "```",
    ].join("\n");
    expect([...placedMediaSrcs(content)]).toEqual([shot, clip, before, after]);
  });

  it("ignores images that are not session media", () => {
    expect(
      placedMediaSrcs("![x](https://example.com/a.png) and /tmp/shot.png"),
    ).toEqual(new Set());
    expect(placedMediaSrcs(undefined)).toEqual(new Set());
  });
});

describe("unplacedMedia", () => {
  it("returns the same array when the body placed nothing", () => {
    const images = [shot];
    expect(unplacedMedia(images, "Old entry, marker stripped.")).toBe(images);
    expect(unplacedMedia(undefined, `![](${shot})`)).toBeUndefined();
  });

  it("drops what the body already shows and keeps the rest", () => {
    const touched = "/media?path=%2Ftmp%2Ftouched.png";
    expect(unplacedMedia([shot, touched], `![](${shot})`)).toEqual([touched]);
    expect(unplacedMedia([shot], `![](${shot})`)).toEqual([]);
  });
});
