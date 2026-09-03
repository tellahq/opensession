import { describe, expect, it } from "bun:test";
import {
  attachmentUrl,
  parseAttachmentRender,
  spliceUserAttachments,
  userAttachmentKind,
  userAttachmentMarkdown,
} from "./gh-attachments";

// Shapes taken from real /markdown responses for tellahq/opensession#96
// (2026-08-15): the image form renders an <img>, the bare form of a video
// renders GitHub's <details> player block, and an unresolvable attachment
// (wrong context repo, or no access) comes back as a plain link.
const SIGNED_MP4 =
  "https://private-user-images.githubusercontent.com/213769834/636480358-e2c35ea7-14b4-4400-9bc7-2f1fe486b35e.mp4?jwt=eyJ0&amp;x=1";

describe("GitHub attachment markdown", () => {
  const image = {
    path: "/tmp/login.error.png",
    url: "https://github.com/user-attachments/assets/image-id",
    kind: "image" as const,
    alt: "Login [error]\nstate",
  };
  const video = {
    path: "/tmp/demo.mp4",
    url: "https://github.com/user-attachments/assets/video-id",
    kind: "video" as const,
  };

  it("recognizes every image and video format supported by gh 2.99", () => {
    for (const extension of ["png", "jpg", "jpeg", "gif", "webp", "svg"])
      expect(userAttachmentKind(`/tmp/file.${extension}`)).toBe("image");
    for (const extension of ["mp4", "mov", "webm"])
      expect(userAttachmentKind(`/tmp/file.${extension}`)).toBe("video");
    expect(userAttachmentKind("/tmp/file.txt")).toBeNull();
  });

  it("escapes image alt text and leaves videos as bare player URLs", () => {
    expect(userAttachmentMarkdown(image)).toBe(
      "![Login \\[error\\] state](https://github.com/user-attachments/assets/image-id)",
    );
    expect(userAttachmentMarkdown(video)).toBe(video.url);
  });

  it("places referenced media and appends the rest as separate paragraphs", () => {
    expect(
      spliceUserAttachments("Before\n\n{{media:2}}\n\nAfter", [image, video]),
    ).toBe(
      "Before\n\nhttps://github.com/user-attachments/assets/video-id\n\nAfter\n\n![Login \\[error\\] state](https://github.com/user-attachments/assets/image-id)",
    );
  });

  it("keeps old image placeholders working", () => {
    expect(spliceUserAttachments("{{image:1}}", [image])).toBe(
      "![Login \\[error\\] state](https://github.com/user-attachments/assets/image-id)",
    );
  });

  it("keeps an out-of-range placeholder instead of pointing it at the wrong file", () => {
    expect(spliceUserAttachments("{{media:3}}", [image])).toBe(
      "{{media:3}}\n\n![Login \\[error\\] state](https://github.com/user-attachments/assets/image-id)",
    );
  });
});

describe("parseAttachmentRender", () => {
  it("prefers the video answer and unescapes entities", () => {
    const html =
      `<p><a href="x"><img src="https://private-user-images.githubusercontent.com/1/2-a.png?jwt=b"></a></p>` +
      `<details open class="details-reset"><summary>demo.mp4</summary><video src="${SIGNED_MP4}" controls="controls"></video></details>`;
    expect(parseAttachmentRender(html)).toEqual({
      url: "https://private-user-images.githubusercontent.com/213769834/636480358-e2c35ea7-14b4-4400-9bc7-2f1fe486b35e.mp4?jwt=eyJ0&x=1",
      kind: "video",
    });
  });

  it("falls back to the image answer", () => {
    const html = `<p><a href="x"><img src="https://private-user-images.githubusercontent.com/1/2-a.png?jwt=b&amp;c=d" alt="a"></a></p>`;
    expect(parseAttachmentRender(html)).toEqual({
      url: "https://private-user-images.githubusercontent.com/1/2-a.png?jwt=b&c=d",
      kind: "image",
    });
  });

  it("reports an unresolved render (plain links, no signed media) as null", () => {
    const url = attachmentUrl("D087B2CD-9724-4D3D-8B0E-8C25700395E1");
    expect(url).toBe(
      "https://github.com/user-attachments/assets/d087b2cd-9724-4d3d-8b0e-8c25700395e1",
    );
    const html = `<p><a href="${url}">${url}</a></p>`;
    expect(parseAttachmentRender(html)).toBeNull();
  });

  it("never mistakes a camo-proxied image for the signed answer", () => {
    const html = `<p><img src="https://camo.githubusercontent.com/abc/def" alt=""></p>`;
    expect(parseAttachmentRender(html)).toBeNull();
  });
});
