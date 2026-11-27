import { describe, expect, test } from "bun:test";
import {
  PIP_MIN_CONTAINER_WIDTH_PX,
  pickLookingAtImage,
} from "./looking-at-image-pip";

describe("pickLookingAtImage", () => {
  test("picks the last image scrolled above the viewport on wide panes", () => {
    const chosen = pickLookingAtImage({
      containerWidth: PIP_MIN_CONTAINER_WIDTH_PX + 100,
      containerTop: 100,
      containerBottom: 900,
      scrollTop: 500,
      images: [
        { src: "/a.png", alt: "First", top: -700, bottom: -500 },
        { src: "/b.png", alt: "Second", top: -240, bottom: -40 },
        { src: "/c.png", alt: "Third", top: 1050, bottom: 1250 },
      ],
    });
    expect(chosen?.src).toBe("/b.png");
  });

  test("hides on narrow panes or whenever an image is already in view", () => {
    expect(
      pickLookingAtImage({
        containerWidth: PIP_MIN_CONTAINER_WIDTH_PX - 10,
        containerTop: 100,
        containerBottom: 900,
        scrollTop: 500,
        images: [{ src: "/a.png", alt: "", top: -240, bottom: -40 }],
      }),
    ).toBeNull();

    expect(
      pickLookingAtImage({
        containerWidth: PIP_MIN_CONTAINER_WIDTH_PX + 100,
        containerTop: 100,
        containerBottom: 900,
        scrollTop: 500,
        images: [
          { src: "/a.png", alt: "", top: -240, bottom: -40 },
          { src: "/b.png", alt: "", top: 300, bottom: 520 },
        ],
      }),
    ).toBeNull();
  });
});
