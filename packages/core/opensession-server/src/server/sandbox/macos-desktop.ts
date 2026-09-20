/**
 * Desktop control for a macOS guest (the tart provider) over the Sandbox's
 * own `exec`: `screencapture` for screenshots, `cliclick` (Homebrew) for
 * mouse and keyboard, AppleScript for the display size and window list. The
 * guest image grants the SSH user Screen Recording and Accessibility at
 * preparation time, so none of these prompt.
 */
import type {
  ExecOpts,
  ExecResult,
  SandboxDesktopControl,
  SandboxDesktopWindow,
  SandboxMouseButton,
  SandboxScreenshot,
} from "./provider";

export type MacExec = (cmd: string[], opts?: ExecOpts) => Promise<ExecResult>;

const SHOT_PATH = "/tmp/opensession-desktop.png";

/** cliclick key names for the chord vocabulary the desktop MCP documents. */
const MAC_KEY_ALIASES: Record<string, string> = {
  enter: "return",
  return: "return",
  esc: "esc",
  escape: "esc",
  tab: "tab",
  space: "space",
  backspace: "delete",
  delete: "fwd-delete",
  del: "fwd-delete",
  home: "home",
  end: "end",
  pageup: "page-up",
  page_up: "page-up",
  pagedown: "page-down",
  page_down: "page-down",
  up: "arrow-up",
  down: "arrow-down",
  left: "arrow-left",
  right: "arrow-right",
  f1: "f1",
  f2: "f2",
  f3: "f3",
  f4: "f4",
  f5: "f5",
  f6: "f6",
  f7: "f7",
  f8: "f8",
  f9: "f9",
  f10: "f10",
  f11: "f11",
  f12: "f12",
};

const MAC_MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  win: "cmd",
};

/** Translate one chord (`cmd+shift+t`, `Return`, `a`) into cliclick
 *  commands: modifiers held with `kd:`, the key pressed with `kp:` or typed
 *  with `t:`, then released with `ku:`. */
export function macChordCommands(chord: string): string[] {
  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("empty key chord");
  const modifiers: string[] = [];
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MAC_MODIFIERS[lower]) modifiers.push(MAC_MODIFIERS[lower]!);
    else if (key) throw new Error(`key chord "${chord}" names two keys`);
    else key = part;
  }
  if (!key) throw new Error(`key chord "${chord}" has no key`);
  const lower = key.toLowerCase();
  const press = MAC_KEY_ALIASES[lower]
    ? `kp:${MAC_KEY_ALIASES[lower]}`
    : key.length === 1
      ? `t:${key}`
      : null;
  if (!press) throw new Error(`unknown key "${key}" in chord "${chord}"`);
  const held = [...new Set(modifiers)].join(",");
  return held ? [`kd:${held}`, press, `ku:${held}`] : [press];
}

function need(result: ExecResult, what: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed: ${(result.stderr || result.stdout).trim().slice(0, 300) || `exit ${result.exitCode}`}`,
    );
  }
}

/** Parse `osascript` output of Finder's desktop bounds ("0, 0, W, H"). */
export function parseDesktopBounds(
  stdout: string,
): { width: number; height: number } | null {
  const numbers = stdout
    .trim()
    .split(",")
    .map((part) => Number(part.trim()));
  if (numbers.length !== 4 || numbers.some((n) => !Number.isFinite(n)))
    return null;
  const [x0, y0, x1, y1] = numbers as [number, number, number, number];
  const width = x1 - x0;
  const height = y1 - y0;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Parse the tab-separated window list the AppleScript below prints. */
export function parseMacWindows(stdout: string): SandboxDesktopWindow[] {
  const windows: SandboxDesktopWindow[] = [];
  for (const line of stdout.split("\n")) {
    const cells = line.split("\t");
    if (cells.length < 7) continue;
    const [app, title, x, y, w, h, front] = cells;
    const width = Number(w);
    const height = Number(h);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    windows.push({
      id: `${app}:${title}:${x},${y}`,
      title: title?.trim() ? `${title.trim()} (${app})` : String(app),
      x: Number(x) || 0,
      y: Number(y) || 0,
      width,
      height,
      active: front === "1",
    });
  }
  return windows;
}

const WINDOW_LIST_SCRIPT = [
  'tell application "System Events"',
  '  set out to ""',
  "  repeat with proc in (every process whose visible is true)",
  "    set isFront to frontmost of proc",
  "    repeat with w in (every window of proc)",
  "      try",
  "        set {px, py} to position of w",
  "        set {sw, sh} to size of w",
  "        set out to out & (name of proc) & tab & (name of w) & tab & px & tab & py & tab & sw & tab & sh & tab & (isFront as integer) & linefeed",
  "      end try",
  "    end repeat",
  "  end repeat",
  "  return out",
  "end tell",
].join("\n");

const MOUSE_CLICK: Record<SandboxMouseButton, string> = {
  left: "c",
  middle: "c",
  right: "rc",
};

export function macDesktopControl(exec: MacExec): SandboxDesktopControl {
  const cliclick = async (...commands: string[]) => {
    need(await exec(["cliclick", ...commands]), `cliclick ${commands[0]}`);
  };
  const display = async () => {
    const r = await exec([
      "osascript",
      "-e",
      'tell application "Finder" to get bounds of window of desktop',
    ]);
    need(r, "display size");
    const size = parseDesktopBounds(r.stdout);
    if (!size) throw new Error("Could not read the display size");
    return size;
  };
  return {
    async screenshot(options = {}) {
      const format = options.format ?? "png";
      const scale = options.scale ?? 1;
      const size = await display();
      const target =
        format === "jpeg" ? SHOT_PATH.replace(/png$/, "jpg") : SHOT_PATH;
      const capture = [
        "screencapture",
        "-x",
        "-C",
        "-t",
        format === "jpeg" ? "jpg" : "png",
        target,
      ];
      need(await exec(capture), "screencapture");
      if (scale > 0 && scale < 1) {
        // sips resizes in place; keep the aspect ratio by width.
        need(
          await exec([
            "sips",
            "--resampleWidth",
            String(Math.max(1, Math.round(size.width * scale))),
            target,
          ]),
          "sips resample",
        );
      }
      const encoded = await exec(["base64", "-i", target]);
      need(encoded, "screenshot encode");
      return {
        data: encoded.stdout.replace(/\s+/g, ""),
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        width: size.width,
        height: size.height,
      } satisfies SandboxScreenshot;
    },
    display,
    async windows() {
      const r = await exec(["osascript", "-e", WINDOW_LIST_SCRIPT]);
      if (r.exitCode !== 0) return [];
      return parseMacWindows(r.stdout);
    },
    async move(x, y) {
      await cliclick(`m:${Math.round(x)},${Math.round(y)}`);
    },
    async click(x, y, options = {}) {
      const button = options.button ?? "left";
      const at = `${Math.round(x)},${Math.round(y)}`;
      if (options.double && button === "left") await cliclick(`dc:${at}`);
      else await cliclick(`${MOUSE_CLICK[button]}:${at}`);
    },
    async drag(from, to) {
      await cliclick(
        `dd:${Math.round(from.x)},${Math.round(from.y)}`,
        `dm:${Math.round(to.x)},${Math.round(to.y)}`,
        `du:${Math.round(to.x)},${Math.round(to.y)}`,
      );
    },
    async scroll(x, y, direction, amount = 3) {
      await cliclick(`m:${Math.round(x)},${Math.round(y)}`);
      const clicks = Math.max(1, Math.min(50, Math.round(amount)));
      // Scroll wheel events are not in cliclick; arrow keys cover lists and
      // pages, which is what the agent scrolls in practice.
      for (let i = 0; i < clicks; i++) {
        await cliclick(`kp:${direction === "up" ? "arrow-up" : "arrow-down"}`);
      }
    },
    async type(text) {
      if (!text) return;
      await cliclick(`t:${text}`);
    },
    async key(chord) {
      await cliclick(...macChordCommands(chord));
    },
  };
}
