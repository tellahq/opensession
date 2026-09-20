/**
 * The session voice orb: a small luminous sphere whose shape and light react
 * to the two directions of a call. Both directions move it the same way: the
 * surface swells, bends into soft lobes and pulses with whoever is speaking,
 * so the person and the agent read as one consistent motion at one
 * intensity. What tells them apart is the ink: the person lights it purple
 * with a firmer rim, the agent lights it in the accent with a brighter core.
 * Both read real levels the parent's WebAudio analysis writes into a shared
 * ref every frame; at silence the orb breathes slowly and does nothing that
 * could be mistaken for speech.
 *
 * Rendering is one fragment shader on a low-power WebGL context, drawn into a
 * transparent canvas that overscans its box (`ORB_CANVAS_OVERSCAN`) so the
 * halo has room to breathe and never meets the canvas edge. When WebGL is
 * unavailable a restrained Canvas 2D painter draws the same layers (body,
 * core, rim) without the procedural surface. Everything that is not React
 * lives here; the component only mounts the canvas and hands it to
 * `startSessionVoiceOrb`.
 */

/** Normalized 0..1 energy for each direction of the call. */
export interface SessionVoiceOrbLevels {
  /** Microphone energy: what the person is saying. */
  input: number;
  /** Speaker energy: what the call is saying back. */
  output: number;
}

/**
 * The ref the parent updates from its analyser and the orb reads every frame.
 * Structural on purpose so a `useRef<SessionVoiceOrbLevels>()` result fits
 * without a cast, whatever React calls its ref type this year.
 */
export interface SessionVoiceOrbLevelsRef {
  current: SessionVoiceOrbLevels;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Fast attack so a syllable lands on the frame it starts. */
export const ORB_ATTACK_MS = 45;
/** Slower release so the surface settles instead of flickering. */
export const ORB_RELEASE_MS = 190;
/** The live/resting crossfade: a pause fades the orb down rather than snapping. */
export const ORB_ACTIVE_ATTACK_MS = 160;
export const ORB_ACTIVE_RELEASE_MS = 320;
/** How fast the halo hands over between the person's ink and the agent's hue. */
export const ORB_TINT_MS = 240;

/**
 * Move `current` toward `target` with an asymmetric, frame-rate independent
 * exponential follower: rises at `attackMs`, falls at `releaseMs`. `dtMs` is
 * the time since the previous frame; a tab that was hidden hands in a large dt
 * and simply lands on the target.
 */
export function followLevel(
  current: number,
  target: number,
  dtMs: number,
  attackMs = ORB_ATTACK_MS,
  releaseMs = ORB_RELEASE_MS,
): number {
  const goal = clamp01(target);
  const from = clamp01(current);
  if (!(dtMs > 0)) return from;
  const tau = goal > from ? attackMs : releaseMs;
  const k = 1 - Math.exp(-dtMs / tau);
  const next = from + (goal - from) * k;
  // Snap the tail so a decaying orb reaches rest and the loop can stop.
  return Math.abs(next - goal) < 0.001 ? goal : next;
}

/** Below this both smoothed levels count as silent. */
export const ORB_SILENT = 0.004;

/**
 * Room tone and analyser noise sit under this; the orb ignores it so silence
 * stays calm instead of shivering with the air conditioning.
 */
export const ORB_GATE = 0.03;

/**
 * Turn a smoothed 0..1 level into the drive the picture uses. Quiet speech
 * still reads as speech, so the curve lifts the low end (a level of 0.25
 * drives at about 0.44) while a shout stays pinned at 1.
 */
export function orbLevelDrive(level: number): number {
  const gated = (clamp01(level) - ORB_GATE) / (1 - ORB_GATE);
  return gated <= 0 ? 0 : Math.pow(gated, 0.6);
}

/**
 * The one energy the shape follows, from both shaped drives. A soft OR: equal
 * to either drive on its own, so the two directions move the orb identically,
 * and only slightly more than the louder one when both speak at once. Bounded
 * to 0..1 like its inputs.
 */
export function orbEnergy(mic: number, voice: number): number {
  const a = clamp01(mic);
  const b = clamp01(voice);
  return a + b - a * b;
}

/**
 * Where the halo's color sits between the agent's hue (0) and the person's
 * ink (1), following whoever is louder. While both are silent it holds where
 * it was, so the last speaker's color fades out rather than snapping to the
 * other one; a handover mid-sentence crossfades over `ORB_TINT_MS`.
 */
export function followOrbTint(
  current: number,
  input: number,
  output: number,
  dtMs: number,
): number {
  const mic = orbLevelDrive(input);
  const voice = orbLevelDrive(output);
  const total = mic + voice;
  if (total <= 0) return clamp01(current);
  return followLevel(current, mic / total, dtMs, ORB_TINT_MS, ORB_TINT_MS);
}

/** Startup is visibly alive before either audio stream exists. Reduced motion
 * keeps a steady glow instead of breathing. This never changes audio levels. */
export function orbConnectionPulse(
  seconds: number,
  reducedMotion: boolean,
): number {
  return reducedMotion
    ? 0.55
    : 0.55 - 0.45 * Math.cos((Math.PI * 2 * seconds) / 1.4);
}

/** Linear sRGB-ish 0..1 triple, what the shader and the fallback gradients eat. */
export type OrbRgb = readonly [number, number, number];

export interface OrbColor {
  /** The resolved CSS color, for Canvas 2D strokes. */
  css: string;
  rgb: OrbRgb;
}

export interface OrbPalette {
  /** The person: rim, lobes and halo while the microphone is live. The semantic purple. */
  input: OrbColor;
  /** The agent: core, body and halo while the speaker is live. The accent. */
  output: OrbColor;
  /** The resting sphere. */
  dim: OrbColor;
}

/**
 * Two chromatic semantic inks. The agent uses the accent when it is distinct
 * from the person and chromatic; otherwise link blue keeps mono and purple
 * accent themes from collapsing the two speakers into one hue.
 */
export const ORB_PALETTE_TOKENS = {
  input: "--purple",
  output: "--accent",
  outputFallback: "--blue",
  dim: "--text-dim",
} as const;

/** Two inks closer than this in every channel read as the same color. */
export const ORB_DISTINCT_INK = 0.18;

export function orbColorsDistinct(a: OrbRgb, b: OrbRgb): boolean {
  return (
    Math.max(
      Math.abs(a[0] - b[0]),
      Math.abs(a[1] - b[1]),
      Math.abs(a[2] - b[2]),
    ) >= ORB_DISTINCT_INK
  );
}

/**
 * Parse a computed CSS color into 0..1 components. Computed styles come back
 * as `rgb(...)`, `rgba(...)`, or, for a `color-mix()` token, `color(srgb ...)`;
 * anything else (which a computed value should never be) parses to null.
 */
export function parseCssColor(value: string): OrbRgb | null {
  const match = /^(rgba?|color)\(\s*(srgb\s+)?([^)]*)\)$/i.exec(value.trim());
  if (!match) return null;
  const [, fn, space, body] = match;
  if (fn.toLowerCase() === "color" && !space) return null;
  const parts = body
    .split(/[\s,/]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const scale = space ? 1 : 1 / 255;
  return [
    clamp01(parts[0] * scale),
    clamp01(parts[1] * scale),
    clamp01(parts[2] * scale),
  ];
}

/**
 * Read a color the browser can compute but `parseCssColor` cannot read, by
 * painting it into a one-pixel 2D canvas. Null when the color is invalid or
 * fully transparent, or when no 2D canvas is available.
 */
export function probeCanvasColor(doc: Document, css: string): OrbRgb | null {
  const canvas = doc.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (!a) return null;
  return [r / 255, g / 255, b / 255];
}

/**
 * Resolve theme tokens to concrete colors through a probe element.
 * `getPropertyValue` would hand back the token stream (`var(--text)`, a
 * `color-mix(...)`) rather than a color; the computed `color` of an element
 * painted with it is always resolved. A token that resolves to no usable
 * color reads as null; the orb never invents ink of its own.
 */
export function readThemeColors(
  tokens: readonly string[],
  root: HTMLElement = document.documentElement,
): Array<OrbColor | null> {
  const doc = root.ownerDocument;
  const probe = doc.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;width:0;height:0";
  root.appendChild(probe);
  try {
    return tokens.map((token) => {
      probe.style.color = `var(${token})`;
      const css = getComputedStyle(probe).color;
      const rgb = parseCssColor(css) ?? probeCanvasColor(doc, css);
      return rgb ? { css, rgb } : null;
    });
  } finally {
    probe.remove();
  }
}

/** Pick distinct chromatic speaker inks, including mono and purple accents. */
export function chooseOrbPalette(
  colors: Record<keyof typeof ORB_PALETTE_TOKENS, OrbColor | null>,
): OrbPalette | null {
  const { input, dim, outputFallback } = colors;
  if (!input || !dim) return null;
  const output =
    colors.output &&
    Math.max(...colors.output.rgb) - Math.min(...colors.output.rgb) >=
      ORB_DISTINCT_INK &&
    orbColorsDistinct(colors.output.rgb, input.rgb)
      ? colors.output
      : outputFallback;
  return output ? { input, output, dim } : null;
}

/** The theme's three inks, or null when they cannot be resolved here. */
export function resolveOrbPalette(root?: HTMLElement): OrbPalette | null {
  const [input, output, outputFallback, dim] = readThemeColors(
    [
      ORB_PALETTE_TOKENS.input,
      ORB_PALETTE_TOKENS.output,
      ORB_PALETTE_TOKENS.outputFallback,
      ORB_PALETTE_TOKENS.dim,
    ],
    root,
  );
  return chooseOrbPalette({ input, output, outputFallback, dim });
}

/**
 * The canvas is this much larger than the orb's box on each axis, centered
 * on it, so the halo and the swell have room outside the box and nothing is
 * ever cut off square. The component's canvas inset must match: 1.5 is
 * `-inset-1/4` (a quarter of the box on every side).
 */
export const ORB_CANVAS_OVERSCAN = 1.5;

/**
 * Radii in canvas units, where 1 is half the canvas (the inscribed circle).
 * The resting body fills three quarters of the box; the halo is windowed to
 * reach zero at `ORB_HALO_EDGE`, inside the inscribed circle, so the corners
 * and edges of the canvas are always fully transparent.
 */
export const ORB_REST_RADIUS = 0.75 / ORB_CANVAS_OVERSCAN;
export const ORB_HALO_EDGE = 0.985;

/**
 * The shape of one frame, derived from the shaped levels. Every term is
 * bounded so the surface (`body ± deform ± pulse`) stays inside `reach`, and
 * `reach` stays inside the halo window: what the shader draws never touches
 * the canvas edge whatever either voice does.
 *
 * The shape does not know who is speaking: it follows `orbEnergy`, so equal
 * microphone and speaker levels produce the same swell, lobes and pulse.
 */
export interface OrbGeometry {
  /** Mean radius of the surface. Swells with whoever is speaking. */
  body: number;
  /** Amplitude of the lobes speech bends into the surface. */
  deform: number;
  /** Amplitude of the fast pulse speech beats into the body. */
  pulse: number;
  /** Outermost radius the surface can reach this frame. */
  reach: number;
  /** Distance past the surface over which the halo fades to nothing. */
  fade: number;
}

export function orbGeometry(
  input: number,
  output: number,
  active: number,
  connecting = 0,
): OrbGeometry {
  const act = clamp01(active);
  const energy = orbEnergy(orbLevelDrive(input), orbLevelDrive(output));
  const body =
    ORB_REST_RADIUS * (1 + act * (0.12 * energy + 0.12 * clamp01(connecting)));
  // A resting orb keeps a hint of surface drift so it reads as alive; speech
  // multiplies it into soft lobes, moderate enough to stay a sphere.
  const deform = ORB_REST_RADIUS * (0.02 + act * 0.16 * energy);
  const pulse = ORB_REST_RADIUS * act * 0.05 * energy;
  const reach = body + deform + pulse;
  return { body, deform, pulse, reach, fade: ORB_HALO_EDGE - reach };
}

/** Everything a frame needs, derived once per frame from the smoothed levels. */
export interface OrbFrame {
  /** Canvas size in CSS pixels (the orb is square). */
  size: number;
  /** Device pixel ratio the backing store was allocated at. */
  dpr: number;
  /** Smoothed, unshaped microphone level. */
  input: number;
  /** Smoothed, unshaped speaker level. */
  output: number;
  /** 0 resting .. 1 live, smoothed, so a pause fades the orb down. */
  active: number;
  /** Neutral startup glow/pulse; zero once connected. */
  connecting?: number;
  /** Halo color, 0 the agent's hue .. 1 the person's ink. */
  tint: number;
  /** Procedural phase in seconds. Held still under reduced motion. */
  time: number;
  palette: OrbPalette;
}

export interface OrbRenderer {
  readonly kind: "webgl" | "canvas2d";
  draw(frame: OrbFrame): void;
  dispose(): void;
}

const VERTEX_SHADER = `attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

/**
 * The orb, in one pass. Coordinates are -1..1 across the canvas. The surface
 * radius is `u_body + u_deform * wobble + u_pulse * beat`, with `wobble` and
 * `beat` both in -1..1, so the JS-side geometry bounds it exactly.
 *
 * Layers, each with its own alpha so the same shader reads as a luminous body
 * on a dark theme and a solid ink one on a light theme:
 *   resting sphere  dim ink, lit from the upper left, with a fresnel edge
 *   body            a drifting value-noise field and a core, in the speaker's
 *                   color, that grow and brighten with either voice; the
 *                   agent's hue lifts the core a little further
 *   rim             fresnel, an edge line and a wash across the raised lobes,
 *                   in the speaker's color, that firm up with either voice;
 *                   the person's ink lifts the rim a little further
 *   halo            outside the surface, tinted by whoever is speaking,
 *                   windowed to zero before the canvas edge
 * The body and rim budgets are balanced so equal levels in either direction
 * light the orb with the same weight; `u_tint` decides the color.
 * `u_active` fades every live layer so a pause settles to the resting sphere.
 * The output is premultiplied, matching the context's `premultipliedAlpha`.
 */
export const ORB_FRAGMENT_SHADER = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform float u_in;
uniform float u_out;
uniform float u_active;
uniform float u_startup;
uniform float u_body;
uniform float u_deform;
uniform float u_pulse;
uniform float u_fade;
uniform float u_tint;
uniform vec3 u_cin;
uniform vec3 u_cout;
uniform vec3 u_cdim;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Three octaves, normalized to 0..1.
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    v += amp * vnoise(p);
    p = p * 2.1 + vec2(3.7, 1.3);
    amp *= 0.5;
  }
  return v / 0.875;
}

void main() {
  float px = 2.0 / min(u_res.x, u_res.y);
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) * px;
  float r = length(uv);
  float ang = atan(uv.y, uv.x);
  vec2 ring = vec2(cos(ang), sin(ang));
  float t = u_time;
  float act = u_active;
  // One energy for both directions, the same soft OR as orbEnergy.
  float lvl = u_in + u_out - u_in * u_out;

  // Surface: organic drift blended with rotating lobes, both in -1..1, so the
  // wobble is bounded and either voice can push it without escaping.
  float drift = fbm(ring * 1.6 + vec2(t * 0.35, -t * 0.27)) * 2.0 - 1.0;
  float lobes = 0.5 * sin(3.0 * ang + t * 2.3)
    + 0.3 * sin(5.0 * ang - t * 3.1 + 1.7)
    + 0.2 * sin(8.0 * ang + t * 4.7);
  float wobble = mix(drift, lobes, 0.35 + 0.3 * lvl);
  float beat = sin(t * 7.0);
  float rad = u_body + u_deform * wobble + u_pulse * beat;
  float d = r - rad;
  float inner = 1.0 - smoothstep(-px, px, d);

  // Sphere shading for the resting body, plus a fresnel edge.
  float q = clamp(r / rad, 0.0, 1.0);
  float h = sqrt(1.0 - q * q);
  vec3 n = normalize(vec3(uv, h * rad));
  vec3 light = normalize(vec3(-0.45, 0.65, 0.6));
  float lit = 0.5 + 0.5 * dot(n, light);
  float fres = pow(1.0 - h, 2.2);
  float spec = pow(max(dot(n, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 28.0);

  // Resting sphere: shaded glass in the dim ink with a glint in the person's ink.
  vec3 col = u_cdim;
  float alpha = inner * (0.08 + 0.26 * lit + 0.22 * fres);
  vec3 speakerColor = mix(u_cout, u_cin, u_tint);
  col = mix(col, speakerColor, act * lvl * 0.85);
  col = mix(col, u_cin, spec * 0.5);
  alpha += inner * (spec * 0.22 + act * u_startup * 0.4);

  // Body: a fluid field in the speaker's color that floods the sphere as
  // either voice speaks, and a core that grows from a glow toward the rim.
  // The agent's hue lifts the core a little further than the person's.
  float flow = fbm(uv * (2.6 + 1.2 * lvl) + vec2(t * 0.22, t * 0.18) + drift * 0.3);
  float coreDrive = 0.5 * lvl + 0.2 * u_out;
  float core = exp(-r * r / (0.05 + 0.24 * lvl)) * coreDrive * (0.6 + 0.6 * flow);
  float fluidA = act * inner * (0.42 * lvl) * (0.35 + 0.65 * flow) * (0.7 + 0.3 * lit);
  col = mix(col, speakerColor, clamp(fluidA * 3.0, 0.0, 1.0));
  alpha += fluidA;
  float coreA = act * inner * core;
  col = mix(col, speakerColor, coreA);
  alpha += coreA;

  // Rim: firms with either voice, and the raised lobes wash in the speaker's
  // color. The person's ink lifts the rim a little further than the agent's.
  float crest = clamp(0.5 + 0.5 * wobble, 0.0, 1.0);
  float rimDrive = 0.5 * lvl + 0.2 * u_in;
  float edge = 1.0 - smoothstep(0.0, px * 2.0 + 0.02 * lvl, abs(d));
  float washA = act * inner * lvl * (0.16 + 0.2 * crest) * (0.5 + 0.5 * fres);
  float rimA = act * inner * rimDrive * (fres + 0.7 * edge);
  col = mix(col, speakerColor, clamp((washA + rimA) * 1.6, 0.0, 1.0));
  alpha += washA + rimA;

  // Halo: breathes with whoever is speaking, in their color, and is windowed
  // to nothing over u_fade so it can never reach the canvas edge.
  float window = 1.0 - smoothstep(0.0, u_fade, d);
  float halo = exp(-max(d, 0.0) * (11.0 - 5.0 * lvl)) * (1.0 - inner) * act
    * (0.06 + 0.45 * lvl + 0.5 * u_startup) * window;
  // Outside the body, use the speaker tint directly, not dim ink diluted
  // by halo opacity a second time.
  vec3 haloColor = u_startup > 0.0 ? u_cdim : mix(u_cout, u_cin, u_tint);
  col = mix(col, haloColor, 1.0 - inner);
  alpha += halo;

  alpha = clamp(alpha, 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const GL_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: "low-power",
};

/** The uniforms the renderer uploads every frame. */
export const ORB_UNIFORMS = [
  "u_res",
  "u_time",
  "u_in",
  "u_out",
  "u_active",
  "u_startup",
  "u_body",
  "u_deform",
  "u_pulse",
  "u_fade",
  "u_tint",
  "u_cin",
  "u_cout",
  "u_cdim",
] as const;
type OrbUniform = (typeof ORB_UNIFORMS)[number];

/** A compiled program and its uniform locations; rebuilt after a context loss. */
interface OrbProgram {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  uniforms: Record<OrbUniform, WebGLUniformLocation | null>;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (
    !gl.getShaderParameter(shader, gl.COMPILE_STATUS) &&
    !gl.isContextLost()
  ) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function buildOrbProgram(gl: WebGLRenderingContext): OrbProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, ORB_FRAGMENT_SHADER);
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  if (!vertex || !fragment || !program || !buffer) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // The shaders are owned by the program once linked; drop our handles.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    return null;
  }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // One triangle that covers clip space; the fragment shader does the rest.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const pos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  // The shader writes premultiplied color straight into a cleared, transparent
  // buffer; the compositor blends it over the page. No GL blending needed.
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
  // SAFETY: every key in ORB_UNIFORMS is populated below before publication.
  const uniforms = {} as Record<OrbUniform, WebGLUniformLocation | null>;
  for (const name of ORB_UNIFORMS)
    uniforms[name] = gl.getUniformLocation(program, name);
  return { program, buffer, uniforms };
}

/** What the renderers need from a canvas; a test can stub just this. */
export type OrbCanvas = Pick<
  HTMLCanvasElement,
  "width" | "height" | "getContext" | "addEventListener" | "removeEventListener"
>;

/** How a renderer obtains its context; injectable so tests can withhold WebGL. */
export interface OrbContexts {
  webgl(canvas: OrbCanvas): WebGLRenderingContext | null;
  canvas2d(canvas: OrbCanvas): OrbPaintContext | null;
}

export const browserOrbContexts: OrbContexts = {
  webgl: (canvas) => canvas.getContext("webgl", GL_ATTRIBUTES),
  canvas2d: (canvas) => canvas.getContext("2d"),
};

function createWebglOrbRenderer(
  canvas: OrbCanvas,
  contexts: OrbContexts,
): OrbRenderer | null {
  const gl = contexts.webgl(canvas);
  if (!gl) return null;
  let program = buildOrbProgram(gl);
  if (!program) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }
  const onLost = (event: Event) => {
    // Without preventDefault the browser never fires the restore event.
    event.preventDefault();
    program = null;
  };
  const onRestored = () => {
    program = buildOrbProgram(gl);
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return {
    kind: "webgl",
    draw(frame) {
      if (!program || gl.isContextLost()) return;
      const w = canvas.width;
      const h = canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (frame.size <= 0) return;
      const u = program.uniforms;
      const active = clamp01(frame.active);
      const geometry = orbGeometry(
        frame.input,
        frame.output,
        active,
        frame.connecting,
      );
      gl.uniform2f(u.u_res, w, h);
      gl.uniform1f(u.u_time, frame.time);
      gl.uniform1f(u.u_in, orbLevelDrive(frame.input));
      gl.uniform1f(u.u_out, orbLevelDrive(frame.output));
      gl.uniform1f(u.u_active, active);
      gl.uniform1f(u.u_startup, clamp01(frame.connecting ?? 0));
      gl.uniform1f(u.u_body, geometry.body);
      gl.uniform1f(u.u_deform, geometry.deform);
      gl.uniform1f(u.u_pulse, geometry.pulse);
      gl.uniform1f(u.u_fade, geometry.fade);
      gl.uniform1f(u.u_tint, clamp01(frame.tint));
      const { input, output, dim } = frame.palette;
      gl.uniform3f(u.u_cin, input.rgb[0], input.rgb[1], input.rgb[2]);
      gl.uniform3f(u.u_cout, output.rgb[0], output.rgb[1], output.rgb[2]);
      gl.uniform3f(u.u_cdim, dim.rgb[0], dim.rgb[1], dim.rgb[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (program && !gl.isContextLost()) {
        gl.deleteBuffer(program.buffer);
        gl.deleteProgram(program.program);
      }
      program = null;
      // Keep the canvas context reusable: React restarts the renderer when
      // active changes for pause/resume. The owner releases the context once
      // the canvas itself leaves the document.
    },
  };
}

/** The slice of a 2D context the fallback paints with; a test can stub just this. */
export type OrbPaintContext = Pick<
  CanvasRenderingContext2D,
  | "globalAlpha"
  | "strokeStyle"
  | "fillStyle"
  | "lineWidth"
  | "setTransform"
  | "clearRect"
  | "beginPath"
  | "arc"
  | "stroke"
  | "fill"
  | "createRadialGradient"
>;

const TAU = Math.PI * 2;

function rgba([r, g, b]: OrbRgb, alpha: number): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/**
 * The Canvas 2D fallback: the same layers as the shader, without the
 * procedural surface. A lit resting sphere in the dim ink that swells with
 * either voice, a halo in the speaker's color, a core that grows with either
 * voice (the agent lifts it a little further) and a rim that firms with
 * either voice (the person lifts it a little further). Nothing here moves on
 * its own except the neutral connecting pulse. Radii come from `orbGeometry`,
 * so this too stays inside the canvas.
 */
export function drawSessionVoiceOrbFallback(
  ctx: OrbPaintContext,
  frame: OrbFrame,
): void {
  const { size, dpr, palette } = frame;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (size <= 0) return;
  const act = clamp01(frame.active);
  const mic = orbLevelDrive(frame.input);
  const voice = orbLevelDrive(frame.output);
  const energy = orbEnergy(mic, voice);
  const connecting = clamp01(frame.connecting ?? 0);
  const geometry = orbGeometry(frame.input, frame.output, act, connecting);
  const c = size / 2;
  const unit = size / 2;
  const rad = (geometry.body + geometry.pulse) * unit;

  if (act > 0) {
    const halo = ctx.createRadialGradient(
      c,
      c,
      rad,
      c,
      c,
      ORB_HALO_EDGE * unit,
    );
    const who = clamp01(frame.tint);
    const haloRgb: OrbRgb = [
      palette.output.rgb[0] +
        (palette.input.rgb[0] - palette.output.rgb[0]) * who,
      palette.output.rgb[1] +
        (palette.input.rgb[1] - palette.output.rgb[1]) * who,
      palette.output.rgb[2] +
        (palette.input.rgb[2] - palette.output.rgb[2]) * who,
    ];
    halo.addColorStop(
      0,
      rgba(connecting > 0 ? palette.dim.rgb : haloRgb, 0.35),
    );
    halo.addColorStop(1, rgba(connecting > 0 ? palette.dim.rgb : haloRgb, 0));
    ctx.globalAlpha = act * (0.1 + 0.55 * energy + 0.5 * connecting);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(c, c, ORB_HALO_EDGE * unit, 0, TAU);
    ctx.fill();
  }

  const body = ctx.createRadialGradient(
    c - rad * 0.35,
    c - rad * 0.4,
    rad * 0.1,
    c,
    c,
    rad,
  );
  const who = clamp01(frame.tint);
  const drive = act * energy;
  const speakerRgb: OrbRgb = [
    palette.output.rgb[0] +
      (palette.input.rgb[0] - palette.output.rgb[0]) * who,
    palette.output.rgb[1] +
      (palette.input.rgb[1] - palette.output.rgb[1]) * who,
    palette.output.rgb[2] +
      (palette.input.rgb[2] - palette.output.rgb[2]) * who,
  ];
  const bodyRgb: OrbRgb = [
    palette.dim.rgb[0] + (speakerRgb[0] - palette.dim.rgb[0]) * drive,
    palette.dim.rgb[1] + (speakerRgb[1] - palette.dim.rgb[1]) * drive,
    palette.dim.rgb[2] + (speakerRgb[2] - palette.dim.rgb[2]) * drive,
  ];
  body.addColorStop(
    0,
    rgba(bodyRgb, 0.36 + drive * 0.25 + act * connecting * 0.4),
  );
  body.addColorStop(
    1,
    rgba(bodyRgb, 0.16 + drive * 0.3 + act * connecting * 0.4),
  );
  ctx.globalAlpha = 1;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(c, c, rad, 0, TAU);
  ctx.fill();

  if (act > 0) {
    const core = ctx.createRadialGradient(
      c,
      c,
      0,
      c,
      c,
      rad * (0.4 + 0.45 * energy + 0.15 * voice),
    );
    core.addColorStop(0, rgba(speakerRgb, 0.9));
    core.addColorStop(1, rgba(speakerRgb, 0));
    ctx.globalAlpha = act * (0.7 * energy + 0.2 * voice);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(c, c, rad, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = act * (0.7 * energy + 0.2 * mic);
    ctx.strokeStyle = rgba(speakerRgb, 1);
    ctx.lineWidth = Math.max(1, size * 0.02 * (1 + 1.2 * energy));
    ctx.beginPath();
    ctx.arc(c, c, rad, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function createCanvas2dOrbRenderer(
  canvas: OrbCanvas,
  contexts: OrbContexts,
): OrbRenderer | null {
  const ctx = contexts.canvas2d(canvas);
  if (!ctx) return null;
  return {
    kind: "canvas2d",
    draw: (frame) => drawSessionVoiceOrbFallback(ctx, frame),
    dispose: () => {},
  };
}

/** WebGL when the browser offers it, the 2D painter otherwise. */
export function createOrbRenderer(
  canvas: OrbCanvas,
  contexts: OrbContexts = browserOrbContexts,
): OrbRenderer | null {
  return (
    createWebglOrbRenderer(canvas, contexts) ??
    createCanvas2dOrbRenderer(canvas, contexts)
  );
}

export interface SessionVoiceOrbOptions {
  active: boolean;
  connecting?: boolean;
}

/** Cap so a 3x phone display does not allocate a 4x backing store for a 48px orb. */
const MAX_DPR = 3;
const REST: SessionVoiceOrbLevels = { input: 0, output: 0 };

/**
 * Own the canvas: pick a renderer, size the backing store to the element at
 * device pixels, resolve the theme palette (and again when the theme
 * attributes change), follow `prefers-reduced-motion`, and run a bounded
 * requestAnimationFrame loop that pauses while the document is hidden and
 * stops once the orb is inactive and has faded to rest. Returns the teardown.
 */
export function startSessionVoiceOrb(
  canvas: HTMLCanvasElement,
  levels: SessionVoiceOrbLevelsRef,
  options: SessionVoiceOrbOptions,
): () => void {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView ?? window;
  // No resolvable theme ink means nothing to paint with; stay dark rather
  // than guess a color.
  const initialPalette = resolveOrbPalette(doc.documentElement);
  if (!initialPalette) return () => {};
  const renderer = createOrbRenderer(canvas);
  if (!renderer) return () => {};
  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)");

  let palette = initialPalette;
  let reducedMotion = reduced.matches;
  let size = 0;
  let dpr = 0;
  let input = 0;
  let output = 0;
  let activeMix = 0;
  let tint = 0;
  let phase = 0;
  let connectionTime = 0;
  let frameId = 0;
  let lastTick = 0;
  let stopped = false;

  const fitBackingStore = () => {
    const rect = canvas.getBoundingClientRect();
    const cssSize = Math.max(0, Math.min(rect.width, rect.height));
    const nextDpr = Math.min(MAX_DPR, Math.max(1, win.devicePixelRatio || 1));
    if (cssSize === size && nextDpr === dpr) return;
    size = cssSize;
    dpr = nextDpr;
    const px = Math.max(1, Math.round(cssSize * dpr));
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
  };

  const settled = () =>
    !options.active &&
    activeMix === 0 &&
    input <= ORB_SILENT &&
    output <= ORB_SILENT;

  const tick = (now: number) => {
    frameId = 0;
    if (stopped) return;
    const dt = lastTick ? Math.min(now - lastTick, 250) : 16;
    lastTick = now;
    const target =
      options.active && !options.connecting ? levels.current : REST;
    connectionTime += dt / 1000;
    input = followLevel(input, target.input, dt);
    output = followLevel(output, target.output, dt);
    activeMix = followLevel(
      activeMix,
      options.active ? 1 : 0,
      dt,
      ORB_ACTIVE_ATTACK_MS,
      ORB_ACTIVE_RELEASE_MS,
    );
    tint = followOrbTint(tint, input, output, dt);
    // The surface drifts slowly at silence and flows faster with energy.
    // Reduced motion holds the phase, so only the levels move the orb.
    if (!reducedMotion)
      phase +=
        (dt / 1000) *
        (0.4 + 1.6 * Math.max(orbLevelDrive(input), orbLevelDrive(output)));
    fitBackingStore();
    renderer.draw({
      size,
      dpr,
      input,
      output,
      active: activeMix,
      connecting:
        options.active && options.connecting
          ? orbConnectionPulse(connectionTime, reducedMotion)
          : 0,
      tint,
      time: phase,
      palette,
    });
    // Keep going while there is anything to show or decay; a still, resting
    // orb costs nothing until something wakes it.
    if (!settled()) schedule();
  };

  const schedule = () => {
    if (stopped || frameId || doc.visibilityState === "hidden") return;
    frameId = win.requestAnimationFrame(tick);
  };

  const wake = () => {
    lastTick = 0;
    schedule();
  };

  const onVisibility = () => {
    if (doc.visibilityState === "hidden") {
      if (frameId) win.cancelAnimationFrame(frameId);
      frameId = 0;
    } else {
      wake();
    }
  };
  const onReducedMotion = (event: MediaQueryListEvent) => {
    reducedMotion = event.matches;
    wake();
  };

  const resize =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          fitBackingStore();
          wake();
        });
  resize?.observe(canvas);

  const theme =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          palette = resolveOrbPalette(doc.documentElement) ?? palette;
          wake();
        });
  theme?.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-accent", "class", "style"],
  });

  doc.addEventListener("visibilitychange", onVisibility);
  reduced.addEventListener("change", onReducedMotion);
  wake();

  return () => {
    stopped = true;
    if (frameId) win.cancelAnimationFrame(frameId);
    frameId = 0;
    resize?.disconnect();
    theme?.disconnect();
    doc.removeEventListener("visibilitychange", onVisibility);
    reduced.removeEventListener("change", onReducedMotion);
    renderer.dispose();
    if (!canvas.isConnected && renderer.kind === "webgl")
      canvas
        .getContext("webgl")
        ?.getExtension("WEBGL_lose_context")
        ?.loseContext();
  };
}
