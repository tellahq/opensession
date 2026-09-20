import { describe, expect, test } from "bun:test";
import {
  ORB_ATTACK_MS,
  orbConnectionPulse,
  ORB_CANVAS_OVERSCAN,
  ORB_HALO_EDGE,
  ORB_UNIFORMS,
  ORB_GATE,
  chooseOrbPalette,
  followOrbTint,
  orbEnergy,
  orbGeometry,
  orbLevelDrive,
  ORB_FRAGMENT_SHADER,
  ORB_RELEASE_MS,
  clamp01,
  createOrbRenderer,
  drawSessionVoiceOrbFallback,
  followLevel,
  parseCssColor,
  type OrbCanvas,
  type OrbFrame,
  type OrbPaintContext,
} from "./session-voice-orb";

describe("followLevel", () => {
  test("rises faster than it falls", () => {
    const up = followLevel(0, 1, 16);
    const down = 1 - followLevel(1, 0, 16);
    expect(up).toBeGreaterThan(down);
    expect(up).toBeCloseTo(1 - Math.exp(-16 / ORB_ATTACK_MS), 6);
    expect(down).toBeCloseTo(1 - Math.exp(-16 / ORB_RELEASE_MS), 6);
  });

  test("is frame-rate independent: two 8ms steps equal one 16ms step", () => {
    const twice = followLevel(followLevel(0.2, 0.9, 8), 0.9, 8);
    expect(twice).toBeCloseTo(followLevel(0.2, 0.9, 16), 9);
  });

  test("lands on the target after a long gap and snaps the tail to rest", () => {
    expect(followLevel(0.8, 0, 5000)).toBe(0);
    let level = 1;
    for (let i = 0; i < 200; i++) level = followLevel(level, 0, 16);
    expect(level).toBe(0);
  });

  test("clamps garbage and holds still without time", () => {
    expect(followLevel(0.4, Number.NaN, 16)).toBeLessThan(0.4);
    expect(followLevel(0.4, 7, 16)).toBeLessThanOrEqual(1);
    expect(followLevel(0.4, 0.9, 0)).toBe(0.4);
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("parseCssColor", () => {
  test("reads the computed color forms a theme token resolves to", () => {
    expect(parseCssColor("rgb(255, 0, 51)")).toEqual([1, 0, 0.2]);
    expect(parseCssColor("rgba(0, 255, 0, 0.16)")).toEqual([0, 1, 0]);
    expect(parseCssColor("rgb(255 255 0 / 0.5)")).toEqual([1, 1, 0]);
    expect(parseCssColor("color(srgb 0.25 0.5 1)")).toEqual([0.25, 0.5, 1]);
    expect(parseCssColor("color(srgb 0.25 0.5 1 / 0.12)")).toEqual([
      0.25, 0.5, 1,
    ]);
  });

  test("refuses anything that is not a resolved color", () => {
    expect(parseCssColor("var(--text)")).toBeNull();
    expect(parseCssColor("color-mix(in srgb, red 50%, blue)")).toBeNull();
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseCssColor("rgb(1, 2)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
});

describe("fragment shader", () => {
  test("declares every uniform the renderer uploads", () => {
    for (const name of ORB_UNIFORMS) {
      expect(ORB_FRAGMENT_SHADER).toContain(
        `uniform ${name === "u_res" ? "vec2" : name.startsWith("u_c") ? "vec3" : "float"} ${name};`,
      );
    }
    expect(ORB_FRAGMENT_SHADER).toContain(
      "gl_FragColor = vec4(col * alpha, alpha)",
    );
  });
});

/** A canvas 2D context that records what was painted, and with what. */
function recordingContext() {
  const ops: string[] = [];
  const gradients: Array<{ radius: number; stops: string[] }> = [];
  const strokes: Array<{ style: string; alpha: number }> = [];
  const ctx: OrbPaintContext = {
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    setTransform: () => ops.push("setTransform"),
    clearRect: () => ops.push("clearRect"),
    beginPath: () => ops.push("beginPath"),
    arc: () => ops.push("arc"),
    createRadialGradient(_x0, _y0, _r0, _x1, _y1, r1) {
      const stops: string[] = [];
      gradients.push({ radius: r1, stops });
      return {
        addColorStop: (_offset: number, color: string) => stops.push(color),
      };
    },
    stroke() {
      ops.push("stroke");
      strokes.push({
        style: String(this.strokeStyle),
        alpha: this.globalAlpha,
      });
    },
    fill: () => ops.push("fill"),
  };
  return { ctx, ops, gradients, strokes };
}

const palette = {
  input: { css: "rgb(1, 1, 1)", rgb: [1 / 255, 1 / 255, 1 / 255] as const },
  output: { css: "rgb(2, 2, 2)", rgb: [2 / 255, 2 / 255, 2 / 255] as const },
  dim: { css: "rgb(3, 3, 3)", rgb: [3 / 255, 3 / 255, 3 / 255] as const },
};
const frame = (over: Partial<OrbFrame>): OrbFrame => ({
  size: 48,
  dpr: 2,
  input: 0,
  output: 0,
  active: 1,
  time: 0.5,
  tint: 0,
  palette,
  ...over,
});

describe("drawSessionVoiceOrbFallback", () => {
  test("resting paints one dim sphere and nothing live", () => {
    const { ops, gradients, strokes, ctx } = recordingContext();
    drawSessionVoiceOrbFallback(ctx, frame({ active: 0, input: 1, output: 1 }));
    expect(ops.filter((op) => op === "fill")).toHaveLength(1);
    expect(strokes).toHaveLength(0);
    expect(gradients).toHaveLength(1);
    expect(
      gradients[0].stops.every((stop) => stop.startsWith("rgba(3, 3, 3")),
    ).toBe(true);
  });

  test("either voice swells the body, halo, core and rim by the same amount", () => {
    const quiet = recordingContext();
    drawSessionVoiceOrbFallback(quiet.ctx, frame({}));
    const mic = recordingContext();
    drawSessionVoiceOrbFallback(mic.ctx, frame({ input: 0.7, tint: 1 }));
    const ai = recordingContext();
    drawSessionVoiceOrbFallback(ai.ctx, frame({ output: 0.7, tint: 0 }));
    // Same geometry: the halo starts at, and the body fills, the same radius.
    expect(mic.gradients[0].radius).toBe(ai.gradients[0].radius);
    expect(mic.gradients[1].radius).toBe(ai.gradients[1].radius);
    expect(mic.gradients[1].radius).toBeGreaterThan(quiet.gradients[1].radius);
    // Each direction paints in its own ink at the same alpha budget.
    expect(mic.gradients[0].stops[0]).toStartWith("rgba(1, 1, 1");
    expect(ai.gradients[0].stops[0]).toStartWith("rgba(2, 2, 2");
    expect(mic.gradients[2].stops[0]).toStartWith("rgba(1, 1, 1");
    expect(ai.gradients[2].stops[0]).toStartWith("rgba(2, 2, 2");
    expect(mic.strokes[0].style).toBe("rgba(1, 1, 1, 1)");
    expect(ai.strokes[0].style).toBe("rgba(2, 2, 2, 1)");
    expect(mic.ctx.lineWidth).toBe(ai.ctx.lineWidth);
    expect(mic.ctx.lineWidth).toBeGreaterThan(quiet.ctx.lineWidth);
    expect(mic.strokes[0].alpha).toBeGreaterThan(quiet.strokes[0].alpha);
  });

  test("the speaker lifts the core a little further, the microphone the rim", () => {
    const mic = recordingContext();
    drawSessionVoiceOrbFallback(mic.ctx, frame({ input: 0.7 }));
    const ai = recordingContext();
    drawSessionVoiceOrbFallback(ai.ctx, frame({ output: 0.7 }));
    expect(ai.gradients[2].radius).toBeGreaterThan(mic.gradients[2].radius);
    expect(mic.strokes[0].alpha).toBeGreaterThan(ai.strokes[0].alpha);
    // A modest lift, not a different orb: within a third of each other.
    expect(ai.gradients[2].radius / mic.gradients[2].radius).toBeLessThan(1.34);
    expect(mic.strokes[0].alpha / ai.strokes[0].alpha).toBeLessThan(1.34);
  });

  test("resets alpha and skips painting an unmeasured canvas", () => {
    const { ctx } = recordingContext();
    drawSessionVoiceOrbFallback(ctx, frame({ input: 1, output: 1 }));
    expect(ctx.globalAlpha).toBe(1);
    const empty = recordingContext();
    drawSessionVoiceOrbFallback(empty.ctx, frame({ size: 0 }));
    expect(empty.ops).toEqual(["setTransform", "clearRect"]);
  });
});

describe("createOrbRenderer", () => {
  /** A canvas whose own contexts are never consulted; the probe decides. */
  const canvas: OrbCanvas = {
    width: 96,
    height: 96,
    getContext: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  test("falls back to the 2D painter when WebGL is unavailable", () => {
    const { ctx, ops } = recordingContext();
    const renderer = createOrbRenderer(canvas, {
      webgl: () => null,
      canvas2d: () => ctx,
    });
    expect(renderer?.kind).toBe("canvas2d");
    renderer?.draw(frame({}));
    expect(ops).toContain("fill");
    renderer?.dispose();
  });

  test("returns nothing when no context can be had", () => {
    expect(
      createOrbRenderer(canvas, { webgl: () => null, canvas2d: () => null }),
    ).toBeNull();
  });
});

const calmReach = orbGeometry(0, 0, 1).reach;

describe("voice drive and bounds", () => {
  test("ignores room tone but lifts quiet speech", () => {
    for (const level of [0, 0.01, ORB_GATE, -1, Number.NaN])
      expect(orbLevelDrive(level)).toBe(0);
    expect(orbLevelDrive(0.25)).toBeGreaterThan(0.4);
    expect(orbLevelDrive(1)).toBe(1);
    const calm = orbGeometry(0, 0, 1);
    expect(orbGeometry(ORB_GATE, ORB_GATE, 1)).toEqual(calm);
    expect(calm.pulse).toBe(0);
    expect(calm.deform).toBeLessThan(calm.body * 0.05);
    const mic = orbGeometry(0.5, 0, 1);
    expect(mic.deform).toBeGreaterThan(calm.deform * 5);
    expect(mic.body).toBeGreaterThan(calm.body);
    expect(mic.pulse).toBeGreaterThan(0.01);
    // Moderate: lobes stay a fraction of the sphere, even at a shout.
    const shout = orbGeometry(1, 1, 1);
    expect(shout.deform).toBeLessThan(shout.body * 0.3);
    expect(orbGeometry(1, 1, 0)).toEqual(orbGeometry(0, 0, 0));
  });

  test("equal energy in either direction moves the orb identically", () => {
    for (const level of [0.1, 0.25, 0.5, 0.8, 1]) {
      for (const active of [0.3, 1]) {
        const mic = orbGeometry(level, 0, active);
        const ai = orbGeometry(0, level, active);
        expect(mic).toEqual(ai);
        expect(orbGeometry(level, 0, active, 0.4)).toEqual(
          orbGeometry(0, level, active, 0.4),
        );
      }
    }
    // Both at once grows the orb only a little past the louder one.
    const one = orbGeometry(0.6, 0, 1);
    const both = orbGeometry(0.6, 0.6, 1);
    expect(both.reach).toBeGreaterThan(one.reach);
    expect(both.reach - one.reach).toBeLessThan(one.reach - calmReach);
    expect(orbEnergy(0.7, 0)).toBe(0.7);
    expect(orbEnergy(0, 0.7)).toBe(0.7);
    expect(orbEnergy(1, 1)).toBe(1);
    expect(orbEnergy(0.5, 0.5)).toBe(0.75);
    expect(ORB_FRAGMENT_SHADER).toContain(
      "float lvl = u_in + u_out - u_in * u_out;",
    );
  });

  test("even simultaneous full scale voices leave a transparent padded edge", () => {
    expect(ORB_CANVAS_OVERSCAN).toBe(1.5);
    for (const input of [0, 0.1, 0.5, 1]) {
      for (const output of [0, 0.1, 0.5, 1]) {
        for (const active of [0, 0.5, 1]) {
          const g = orbGeometry(input, output, active);
          expect(g.body - g.deform - g.pulse).toBeGreaterThan(0);
          expect(g.reach).toBeCloseTo(g.body + g.deform + g.pulse);
          expect(g.fade).toBeGreaterThan(0.07);
          expect(g.reach + g.fade).toBe(ORB_HALO_EDGE);
          expect(g.reach + g.fade).toBeLessThan(1);
        }
      }
    }
    expect(ORB_FRAGMENT_SHADER).toContain("smoothstep(0.0, u_fade, d)");
    expect(ORB_FRAGMENT_SHADER).toContain("vec4(col * alpha, alpha)");
  });

  test("handover follows independent inputs smoothly and holds the last tint in silence", () => {
    const mic = followOrbTint(0, 0.6, 0, 16);
    expect(mic).toBeGreaterThan(0);
    expect(mic).toBeLessThan(0.1);
    expect(followOrbTint(mic, 0, 0, 1000)).toBe(mic);
    expect(followOrbTint(1, 0, 0.6, 16)).toBeCloseTo(1 - mic);
    expect(followOrbTint(0, 0.6, 0, 5000)).toBe(1);
    expect(followOrbTint(1, 0, 0.6, 5000)).toBe(0);
    expect(followOrbTint(0.5, 1, 1, 16)).toBe(0.5);
    expect(followOrbTint(0, 1, 0, 16)).toBeCloseTo(
      followOrbTint(followOrbTint(0, 1, 0, 8), 1, 0, 8),
    );
    // The tint carries the speaker's ink; the shape never depends on it.
    for (const tint of [0, 0.5, 1]) {
      const { ctx, gradients } = recordingContext();
      drawSessionVoiceOrbFallback(ctx, frame({ input: 0.6, tint }));
      const g = orbGeometry(0.6, 0, 1);
      expect(gradients[1].radius).toBe((g.body + g.pulse) * 24);
    }
  });

  test("mono and matching accents use semantic link ink to distinguish the agent", () => {
    const input = { css: "rgb(230, 230, 230)", rgb: [0.9, 0.9, 0.9] as const };
    const blue = { css: "rgb(25, 100, 255)", rgb: [0.1, 0.4, 1] as const };
    expect(
      chooseOrbPalette({
        input,
        output: input,
        outputFallback: blue,
        dim: input,
      })?.output,
    ).toBe(blue);
    expect(
      chooseOrbPalette({
        input,
        output: blue,
        outputFallback: null,
        dim: input,
      })?.output,
    ).toBe(blue);
    expect(
      chooseOrbPalette({
        input,
        output: { css: "rgb(230, 230, 230)", rgb: [0.9, 0.9, 0.9] },
        outputFallback: blue,
        dim: input,
      })?.output,
    ).toBe(blue);
    expect(
      chooseOrbPalette({
        input: null,
        output: blue,
        outputFallback: blue,
        dim: input,
      }),
    ).toBeNull();
  });
});

describe("connecting pulse", () => {
  test("breathes without audio on a 1.4 second cycle, and stays steady with reduced motion", () => {
    expect(orbConnectionPulse(0, false)).toBeCloseTo(0.1);
    expect(orbConnectionPulse(0.7, false)).toBe(1);
    expect(orbConnectionPulse(1.4, false)).toBeCloseTo(0.1);
    for (const time of [0, 0.35, 0.7, 1.4, 20]) {
      expect(orbConnectionPulse(time, true)).toBe(0.55);
      const g = orbGeometry(0, 0, 1, orbConnectionPulse(time, false));
      expect(g.reach).toBeLessThan(ORB_HALO_EDGE);
      expect(g.fade).toBeGreaterThan(0);
    }
    expect(orbGeometry(0, 0, 1, 1).body).toBeGreaterThan(
      orbGeometry(0, 0, 1).body,
    );
    expect(orbGeometry(0, 0, 0, 1)).toEqual(orbGeometry(0, 0, 0));
  });

  test("fallback breathes its neutral body and halo without inventing speaker activity", () => {
    const low = recordingContext();
    const high = recordingContext();
    drawSessionVoiceOrbFallback(low.ctx, frame({ connecting: 0.1 }));
    drawSessionVoiceOrbFallback(high.ctx, frame({ connecting: 1 }));
    expect(high.gradients[1].radius).toBeGreaterThan(low.gradients[1].radius);
    expect(high.gradients[1].stops).not.toEqual(low.gradients[1].stops);
    expect(high.strokes[0].alpha).toBe(0);
    expect(high.ctx.globalAlpha).toBe(1);
  });
});
