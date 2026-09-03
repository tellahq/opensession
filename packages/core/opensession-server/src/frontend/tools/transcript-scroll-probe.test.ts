import { describe, expect, test } from "bun:test";
import {
  findOpposingWrites,
  findPrematureTouchWrites,
  findReaderDisplacements,
  findRowArrivalAnimations,
  findRowGeometryTransitions,
  momentumScrolls,
  type ProbeFrame,
  type ProbeWindow,
  type ProbeWrite,
} from "./transcript-scroll-probe";

function frame(
  t: number,
  scrollTop: number,
  anchorTop: number,
  previousAnchorTop: number | null = anchorTop,
  anchor = "entry-a",
): ProbeFrame {
  return {
    t,
    seq: t,
    phase: "history",
    scrollTop,
    scrollHeight: 10_000,
    clientHeight: 700,
    anchor,
    anchorTop,
    previousAnchorTop,
  };
}

function write(
  t: number,
  before: number,
  target: number | null,
  extra: Partial<ProbeWrite> = {},
): ProbeWrite {
  return {
    t,
    seq: t,
    phase: "history",
    kind: "scrollTop",
    before,
    after: target ?? before,
    target,
    scripted: false,
    stack: "correctReader",
    ...extra,
  };
}

function window(partial: Partial<ProbeWindow>): ProbeWindow {
  return {
    writes: [],
    scrolls: [],
    gestures: [],
    motion: [],
    frames: [],
    ...partial,
  };
}

describe("reader displacement", () => {
  test("a reader scrolling through still content is not a displacement", () => {
    const frames = [frame(0, 1000, 40), frame(16, 1120, -80)];
    expect(findReaderDisplacements(window({ frames }))).toEqual([]);
  });

  test("growth above the reader that a write compensates holds the entry", () => {
    const frames = [frame(0, 1000, 40), frame(16, 1128, 40)];
    const writes = [write(8, 1000, 1128)];
    expect(findReaderDisplacements(window({ frames, writes }))).toEqual([]);
  });

  test("uncompensated growth above the reader is a displacement", () => {
    const frames = [frame(0, 1000, 40), frame(16, 1000, 168)];
    const [found] = findReaderDisplacements(window({ frames }));
    expect(found?.deviation).toBe(128);
    expect(found?.writes).toBe(0);
  });

  test("a write undoing reader movement inside one frame is a displacement", () => {
    // The reader moved +300 and the app moved them back before paint: the
    // entry sits 300px below where their own scroll would have put it.
    const frames = [frame(0, 1000, 40), frame(16, 1000, 40)];
    const writes = [write(8, 1300, 1000)];
    const [found] = findReaderDisplacements(window({ frames, writes }));
    expect(found?.compensation).toBe(-300);
    expect(found?.deviation).toBe(300);
  });

  test("a write moving the reader in a later frame is a displacement", () => {
    const frames = [
      frame(0, 1000, 40),
      frame(16, 1300, -260),
      frame(32, 1000, 40),
    ];
    const writes = [write(24, 1300, 1000)];
    const [found] = findReaderDisplacements(window({ frames, writes }));
    expect(found?.t).toBe(32);
    expect(found?.deviation).toBe(300);
  });

  test("compares the previous anchor when a new entry reaches the top", () => {
    const frames = [
      frame(0, 1000, 40, 40, "entry-a"),
      // entry-b is now at the top; entry-a moved up by the 500px scrolled.
      frame(16, 1500, 12, -460, "entry-b"),
    ];
    expect(findReaderDisplacements(window({ frames }))).toEqual([]);
    const jumped = [
      frame(0, 1000, 40, 40, "entry-a"),
      frame(16, 1500, 12, -400, "entry-b"),
    ];
    expect(findReaderDisplacements(window({ frames: jumped }))).toHaveLength(1);
  });

  test("counts what a clamped write did, not what it asked for", () => {
    // The first pass asks for +908 before the container has grown and gets
    // +500; the second lands the rest. Growth above the reader was 870.
    const frames = [frame(0, 1000, 40), frame(16, 1870, 40)];
    const writes = [
      write(4, 1000, 1908, { after: 1500 }),
      write(8, 1500, 1870),
    ];
    expect(findReaderDisplacements(window({ frames, writes }))).toEqual([]);
  });

  test("orders a write against frames by sequence, not timestamp", () => {
    // Sampled in the same timestamp as the frame, but after it.
    const frames = [
      frame(0, 1000, 40),
      frame(16, 1000, 40),
      frame(32, 1128, 40),
    ];
    const writes = [write(16, 1000, 1128, { seq: 16.5 })];
    expect(findReaderDisplacements(window({ frames, writes }))).toEqual([]);
  });

  test("a scripted jump starts a new baseline instead of failing", () => {
    const frames = [frame(0, 1000, 40), frame(16, 4000, 40)];
    const writes = [write(8, 1000, 4000, { scripted: true })];
    expect(findReaderDisplacements(window({ frames, writes }))).toEqual([]);
  });

  test("skips frames whose previous anchor left the DOM", () => {
    const frames = [frame(0, 1000, 40), frame(16, 1000, 400, null)];
    expect(findReaderDisplacements(window({ frames }))).toEqual([]);
  });

  test("tolerates sub-pixel rounding", () => {
    const frames = [frame(0, 1000, 40), frame(16, 1120, -78.8)];
    expect(findReaderDisplacements(window({ frames }))).toEqual([]);
  });
});

describe("opposing writes", () => {
  test("flags a guess and its undo inside one frame", () => {
    const writes = [
      write(100, 1000, 1128, { stack: "scrollToFn" }),
      write(104, 1128, 1000),
    ];
    const [found] = findOpposingWrites(window({ writes }));
    expect(found).toMatchObject({ first: 128, second: -128 });
  });

  test("ignores same-direction, distant, or scripted writes", () => {
    const sameDirection = [write(100, 1000, 1128), write(104, 1128, 1256)];
    expect(findOpposingWrites(window({ writes: sameDirection }))).toEqual([]);
    const distant = [write(100, 1000, 1128), write(400, 1128, 1000)];
    expect(findOpposingWrites(window({ writes: distant }))).toEqual([]);
    const scripted = [
      write(100, 1000, 1128, { scripted: true }),
      write(104, 1128, 1000),
    ];
    expect(findOpposingWrites(window({ writes: scripted }))).toEqual([]);
  });
});

describe("touch settling", () => {
  const gestures: ProbeWindow["gestures"] = [
    { t: 0, phase: "touch", type: "touchstart" },
    { t: 60, phase: "touch", type: "touchmove" },
    { t: 120, phase: "touch", type: "touchend" },
  ];
  const momentum: ProbeWindow["scrolls"] = [
    { t: 70, phase: "touch", scrollTop: 900 },
    { t: 140, phase: "touch", scrollTop: 850 },
    { t: 300, phase: "touch", scrollTop: 800 },
  ];

  test("a write under the finger or inside momentum is premature", () => {
    const underFinger = window({
      gestures,
      scrolls: momentum,
      writes: [write(90, 900, 1028)],
    });
    expect(findPrematureTouchWrites(underFinger)).toHaveLength(1);
    const midMomentum = window({
      gestures,
      scrolls: momentum,
      writes: [write(330, 800, 928)],
    });
    const [found] = findPrematureTouchWrites(midMomentum);
    expect(found?.sinceMomentum).toBe(30);
  });

  test("a write after momentum settles is allowed", () => {
    const settled = window({
      gestures,
      scrolls: momentum,
      writes: [write(460, 800, 928)],
    });
    expect(findPrematureTouchWrites(settled)).toEqual([]);
  });

  test("scroll events caused by the app's own write do not count as momentum", () => {
    const scrolls = [...momentum, { t: 470, phase: "touch", scrollTop: 928 }];
    const probe = window({ gestures, scrolls, writes: [write(460, 800, 928)] });
    expect(momentumScrolls(probe).map((scroll) => scroll.t)).toEqual([
      70, 140, 300,
    ]);
    expect(findPrematureTouchWrites(probe)).toEqual([]);
  });

  test("windows without a touch have nothing to settle", () => {
    expect(
      findPrematureTouchWrites(window({ writes: [write(10, 0, 100)] })),
    ).toEqual([]);
  });
});

describe("row motion", () => {
  test("geometry transitions on rows are flagged, cosmetic ones are not", () => {
    const probe = window({
      motion: [
        {
          t: 0,
          phase: "history",
          type: "transition",
          name: "transform",
          target: "div",
          inRow: true,
        },
        {
          t: 0,
          phase: "history",
          type: "transition",
          name: "opacity",
          target: "div",
          inRow: true,
        },
        {
          t: 0,
          phase: "history",
          type: "transition",
          name: "height",
          target: "div",
          inRow: false,
        },
      ],
    });
    expect(
      findRowGeometryTransitions(probe).map((motion) => motion.name),
    ).toEqual(["transform"]);
  });

  test("arrival animations on hydrated rows are flagged", () => {
    const probe = window({
      motion: [
        {
          t: 0,
          phase: "history",
          type: "animation",
          name: "transcript-enter",
          target: "div",
          inRow: true,
        },
        {
          t: 0,
          phase: "history",
          type: "animation",
          name: "pulse",
          target: "span",
          inRow: true,
        },
        {
          t: 0,
          phase: "history",
          type: "animation",
          name: "transcript-enter",
          target: "div",
          inRow: false,
        },
      ],
    });
    expect(findRowArrivalAnimations(probe)).toHaveLength(1);
  });
});
