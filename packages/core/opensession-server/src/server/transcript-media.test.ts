import { describe, expect, it } from "bun:test";
import {
  assistantProseFields,
  extractAssistantVideos,
  extractMediaMarkers,
  isCaptionLine,
  mediaUrlFor,
  placeMediaMarkers,
  stripMediaMarkers,
} from "./transcript-media";

const shot = "/media?path=%2Ftmp%2Fshot.png";
const before = "/media?path=%2Ftmp%2Fbefore.png";
const after = "/media?path=%2Ftmp%2Fafter.png";

describe("placeMediaMarkers", () => {
  it("leaves text without a marker byte-identical", () => {
    const text = "Plain prose.\n\n- a list\n- with items\n";
    expect(placeMediaMarkers(text)).toEqual({
      content: text,
      images: [],
      videos: [],
      featuredMedia: [],
    });
  });

  it("rewrites an image marker into image syntax where it stands", () => {
    const placed = placeMediaMarkers(
      "## Proof\n\nOPENSESSION_IMAGE: /tmp/shot.png\n\nDone.",
    );
    expect(placed.content).toBe(`## Proof\n\n![](${shot})\n\nDone.`);
    expect(placed.images).toEqual([shot]);
    expect(placed.videos).toEqual([]);
    expect(placed.featuredMedia).toEqual([shot]);
  });

  it("reads through emphasis, backticks and a bullet", () => {
    for (const line of [
      "**OPENSESSION_IMAGE: /tmp/shot.png**",
      "`OPENSESSION_IMAGE: /tmp/shot.png`",
      "- OPENSESSION_IMAGE: /tmp/shot.png",
      "__OPENSESSION_IMAGE: /tmp/shot.png__",
    ]) {
      expect(placeMediaMarkers(line).content).toBe(`![](${shot})`);
    }
  });

  it("keeps a blank line on each side so the figure is its own paragraph", () => {
    const placed = placeMediaMarkers(
      "Look:\nOPENSESSION_IMAGE: /tmp/shot.png\nThat is the header.\nAnd the footer moved too.",
    );
    expect(placed.content).toBe(
      `Look:\n\n![](${shot})\n\nThat is the header.\nAnd the footer moved too.`,
    );
  });

  it("takes one short line directly under the marker as the caption", () => {
    const placed = placeMediaMarkers(
      "OPENSESSION_IMAGE: /tmp/shot.png\nThe login page after the fix\n\nNext paragraph.",
    );
    expect(placed.content).toBe(
      `![The login page after the fix](${shot})\n\nNext paragraph.`,
    );
  });

  it("takes a caption at the end of the message", () => {
    expect(
      placeMediaMarkers("OPENSESSION_IMAGE: /tmp/shot.png\nAfter").content,
    ).toBe(`![After](${shot})`);
  });

  it("takes a caption that is followed by another marker", () => {
    const placed = placeMediaMarkers(
      "OPENSESSION_IMAGE: /tmp/before.png\nBefore\nOPENSESSION_IMAGE: /tmp/after.png\nAfter",
    );
    expect(placed.content).toBe(`![Before](${before})\n\n![After](${after})`);
    expect(placed.images).toEqual([before, after]);
  });

  it("does not eat a paragraph of prose after the marker", () => {
    const placed = placeMediaMarkers(
      "OPENSESSION_IMAGE: /tmp/shot.png\nThis shows the fix. I also\nchanged the header.\n",
    );
    expect(placed.content).toBe(
      `![](${shot})\n\nThis shows the fix. I also\nchanged the header.\n`,
    );
  });

  it("does not take a heading, list, quote, fence or long line as a caption", () => {
    for (const line of [
      "## Next",
      "- item",
      "1. step",
      "> quote",
      "```",
      "| a | b |",
      "![x](y)",
      "x".repeat(161),
    ]) {
      const placed = placeMediaMarkers(
        `OPENSESSION_IMAGE: /tmp/shot.png\n${line}\n`,
      );
      expect(placed.content).toBe(`![](${shot})\n\n${line}\n`);
    }
  });

  it("drops emphasis wrappers and brackets from the alt text", () => {
    expect(
      placeMediaMarkers("OPENSESSION_IMAGE: /tmp/shot.png\n**Before [1]**")
        .content,
    ).toBe(`![Before 1](${shot})`);
  });

  it("rewrites a video marker into image syntax on the video file", () => {
    const placed = placeMediaMarkers(
      "OPENSESSION_VIDEO: /tmp/clip.mp4\nThe whole flow",
    );
    const clip = "/media?path=%2Ftmp%2Fclip.mp4";
    expect(placed.content).toBe(`![The whole flow](${clip})`);
    expect(placed.videos).toEqual([clip]);
    expect(placed.images).toEqual([]);
    expect(placed.featuredMedia).toEqual([clip]);
  });

  it("still reads the pre-rename video marker", () => {
    expect(placeMediaMarkers("BACKSTAGE_VIDEO: /tmp/old.mov").videos).toEqual([
      "/media?path=%2Ftmp%2Fold.mov",
    ]);
  });

  it("rewrites a compare marker into a compare fence with both stills", () => {
    const placed = placeMediaMarkers(
      "Before and after:\n\nOPENSESSION_COMPARE: /tmp/before.png /tmp/after.png\nRetry timeline\n\nDone.",
    );
    expect(placed.content).toBe(
      [
        "Before and after:",
        "",
        "```compare",
        `before: ${before}`,
        `after: ${after}`,
        "caption: Retry timeline",
        "```",
        "",
        "Done.",
      ].join("\n"),
    );
    expect(placed.images).toEqual([before, after]);
    expect(placed.featuredMedia).toEqual([before, after]);
  });

  it("writes a compare fence without a caption line when there is none", () => {
    expect(
      placeMediaMarkers("OPENSESSION_COMPARE: /tmp/before.png /tmp/after.png")
        .content,
    ).toBe(`\`\`\`compare\nbefore: ${before}\nafter: ${after}\n\`\`\``);
  });

  it("ignores a compare marker with one path", () => {
    const text = "OPENSESSION_COMPARE: /tmp/only.png";
    expect(placeMediaMarkers(text).content).toBe(text);
  });

  it("lists a file shown twice once", () => {
    const placed = placeMediaMarkers(
      "OPENSESSION_IMAGE: /tmp/shot.png\n\nOPENSESSION_IMAGE: /tmp/shot.png",
    );
    expect(placed.images).toEqual([shot]);
    expect(placed.content).toBe(`![](${shot})\n\n![](${shot})`);
  });
});

describe("isCaptionLine", () => {
  it("wants a short plain line with nothing but a blank after it", () => {
    expect(isCaptionLine("A caption", undefined)).toBe(true);
    expect(isCaptionLine("A caption", "")).toBe(true);
    expect(isCaptionLine("A caption", "   ")).toBe(true);
    expect(isCaptionLine("A caption", "More prose")).toBe(false);
    expect(isCaptionLine("", undefined)).toBe(false);
    expect(isCaptionLine("OPENSESSION_IMAGE: /tmp/x.png", undefined)).toBe(
      false,
    );
  });
});

describe("mediaUrlFor", () => {
  it("encodes parentheses, which markdown link syntax cannot hold", () => {
    expect(mediaUrlFor("/tmp/shot (1).png")).toBe(
      "/media?path=%2Ftmp%2Fshot%20%281%29.png",
    );
  });
});

describe("extractAssistantVideos", () => {
  it("returns the placed text with images, videos and featured media", () => {
    const out = extractAssistantVideos(
      "Done.\n\nOPENSESSION_IMAGE: /tmp/shot.png\nOPENSESSION_VIDEO: /tmp/clip.mp4\n\n",
    );
    expect(out.content).toBe(
      `Done.\n\n![](${shot})\n\n![](/media?path=%2Ftmp%2Fclip.mp4)`,
    );
    expect(out.images).toEqual([shot]);
    expect(out.videos).toEqual(["/media?path=%2Ftmp%2Fclip.mp4"]);
    expect(out.featuredMedia).toEqual([shot, "/media?path=%2Ftmp%2Fclip.mp4"]);
  });

  it("leaves a plain message untouched with no featured media", () => {
    const out = extractAssistantVideos("Nothing to see.\n");
    expect(out.content).toBe("Nothing to see.\n");
    expect(out.featuredMedia).toEqual([]);
  });
});

describe("assistantProseFields", () => {
  it("spreads only the media keys it found", () => {
    expect(assistantProseFields("Plain.\n")).toEqual({ content: "Plain.\n" });
    expect(assistantProseFields("OPENSESSION_IMAGE: /tmp/shot.png\n")).toEqual({
      content: `![](${shot})`,
      images: [shot],
      featuredMedia: [shot],
    });
  });
});

describe("compare in the Slack grammar", () => {
  it("reads a compare marker as two images, before first", () => {
    expect(
      extractMediaMarkers(
        "OPENSESSION_VIDEO: /tmp/clip.mp4\nOPENSESSION_COMPARE: /tmp/before.png /tmp/after.png\n",
      ),
    ).toEqual([
      { path: "/tmp/clip.mp4", kind: "video" },
      { path: "/tmp/before.png", kind: "image" },
      { path: "/tmp/after.png", kind: "image" },
    ]);
  });

  it("strips a compare line", () => {
    expect(
      stripMediaMarkers("a\nOPENSESSION_COMPARE: /tmp/b.png /tmp/c.png\nd"),
    ).toBe("a\n\nd");
  });
});
