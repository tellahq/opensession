import { describe, expect, test } from "bun:test";
import {
  INSPECT_REPLY,
  type InspectReply,
  browserCommentMessage,
  inspectReply,
  markBetween,
  markBox,
  markCenter,
} from "./browser-annotation";

const frame = new MessageChannel().port1;
const stranger = new MessageChannel().port2;
const reply: InspectReply = {
  type: INSPECT_REPLY,
  id: "r1",
  element: {
    selector: "main > button.plan`cta",
    tag: "button",
    text: "Select   plan",
    rect: { x: 40, y: 60, width: 120, height: 32 },
  },
  scroll: { x: 0, y: 420 },
  viewport: { width: 1280, height: 800 },
};

describe("browser annotation", () => {
  test("a short press marks a point, a drag an area", () => {
    expect(markBetween({ x: 10, y: 10 }, { x: 13, y: 12 })).toEqual({
      kind: "point",
      x: 10,
      y: 10,
    });
    const area = markBetween({ x: 200, y: 90 }, { x: 50, y: 10 });
    expect(area).toEqual({
      kind: "area",
      rect: { x: 50, y: 10, width: 150, height: 80 },
    });
    expect(markCenter(area)).toEqual({ x: 125, y: 50 });
  });

  test("a point marks the element under it when the page names one", () => {
    const point = { kind: "point", x: 50, y: 70 } as const;
    expect(markBox(point, reply.element)).toEqual(reply.element!.rect);
    expect(markBox(point, null)).toEqual({
      x: 42,
      y: 62,
      width: 16,
      height: 16,
    });
  });

  test("replies count only from the frame, for the request", () => {
    expect(inspectReply({ data: reply, source: frame }, frame, "r1")).toEqual(
      reply,
    );
    expect(
      inspectReply({ data: reply, source: frame }, frame, "r2"),
    ).toBeNull();
    expect(
      inspectReply({ data: reply, source: stranger }, frame, "r1"),
    ).toBeNull();
    expect(
      inspectReply(
        { data: { ...reply, element: { tag: "x" } }, source: frame },
        frame,
        "r1",
      ),
    ).toBeNull();
  });

  test("the message says where, then what the person wrote", () => {
    expect(
      browserCommentMessage({
        url: "http://localhost:3000/pricing",
        mark: { kind: "point", x: 50, y: 70 },
        view: { width: 1280, height: 800 },
        inspected: reply,
        text: "  Keep this on one line  ",
      }),
    ).toBe(
      [
        "> Browser comment on http://localhost:3000/pricing",
        "> Point at (50, 70) in a 1280×800 view, scrolled to (0, 420)",
        '> Element `main > button.plan\'cta`: "Select plan"',
        "",
        "Keep this on one line",
      ].join("\n"),
    );
    expect(
      browserCommentMessage({
        url: "https://example.test/",
        mark: { kind: "area", rect: { x: 1, y: 2, width: 30, height: 40 } },
        view: { width: 390, height: 700 },
        inspected: null,
        text: "Too tight",
      }),
    ).toBe(
      [
        "> Browser comment on https://example.test/",
        "> Area 30×40 at (1, 2) in a 390×700 view",
        "",
        "Too tight",
      ].join("\n"),
    );
  });

  test("a scaled asset reports the page's own pixels", () => {
    expect(
      browserCommentMessage({
        url: "/api/sessions/s/assets/raw/shell.html",
        asset: "shell.html",
        mark: { kind: "area", rect: { x: 100, y: 50, width: 64, height: 32 } },
        view: { width: 640, height: 400 },
        inspected: { ...reply, scroll: { x: 0, y: 0 } },
        text: "Bigger",
      }),
    ).toBe(
      [
        "> Comment on asset `shell.html`",
        "> Area 128×64 at (200, 100) in a 1280×800 view",
        '> Element `main > button.plan\'cta`: "Select plan"',
        "",
        "Bigger",
      ].join("\n"),
    );
  });
});
