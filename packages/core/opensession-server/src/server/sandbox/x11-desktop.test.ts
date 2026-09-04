import { describe, expect, test } from "bun:test";
import type { ExecResult } from "./provider";
import {
  parseX11Windows,
  parseXpropWindows,
  x11DesktopControl,
  x11KeyChord,
  x11ScreenshotScript,
  x11WindowsViaXprop,
} from "./x11-desktop";

const XPROP_DUMP = [
  "== 0xa00003 0",
  '_NET_WM_NAME(UTF8_STRING) = "xfce4-panel"',
  'WM_NAME(STRING) = "xfce4-panel"',
  "  Absolute upper-left X:  0",
  "  Absolute upper-left Y:  0",
  "  Width: 1024",
  "  Height: 27",
  "  Map State: IsViewable",
  "== 0x1200007 0",
  'WM_NAME(STRING) = "hidden helper"',
  "  Absolute upper-left X:  -100",
  "  Absolute upper-left Y:  -100",
  "  Width: 10",
  "  Height: 10",
  "  Map State: IsUnMapped",
  "== 0x2200003 1",
  '_NET_WM_NAME(UTF8_STRING) = "Terminal \\"quoted\\""',
  'WM_NAME(STRING) = "Terminal"',
  "  Absolute upper-left X:  5",
  "  Absolute upper-left Y:  56",
  "  Width: 817",
  "  Height: 483",
  "  Map State: IsViewable",
  "",
].join("\n");

describe("parseXpropWindows", () => {
  test("keeps viewable windows with their EWMH title and geometry", () => {
    expect(parseXpropWindows(XPROP_DUMP)).toEqual([
      {
        id: "0xa00003",
        title: "xfce4-panel",
        x: 0,
        y: 0,
        width: 1024,
        height: 27,
        active: false,
      },
      {
        id: "0x2200003",
        title: 'Terminal "quoted"',
        x: 5,
        y: 56,
        width: 817,
        height: 483,
        active: true,
      },
    ]);
  });

  test("an empty or failed listing is an empty list", () => {
    expect(parseXpropWindows("")).toEqual([]);
    expect(parseXpropWindows("xprop: unable to open display")).toEqual([]);
  });
});

describe("x11WindowsViaXprop", () => {
  test("runs one bash script on the given display", async () => {
    const calls: string[][] = [];
    const windows = await x11WindowsViaXprop(async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: XPROP_DUMP, stderr: "" };
    }, ":1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(calls[0]?.[2]).toContain("export DISPLAY=:1;");
    expect(calls[0]?.[2]).toContain("_NET_CLIENT_LIST");
    expect(windows.map((w) => w.title)).toEqual([
      "xfce4-panel",
      'Terminal "quoted"',
    ]);
  });
});

function harness(answers: Record<string, Partial<ExecResult>> = {}) {
  const calls: string[][] = [];
  const control = x11DesktopControl(async (cmd) => {
    calls.push(cmd);
    const key = cmd.join(" ");
    const match = Object.keys(answers).find((needle) => key.includes(needle));
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      ...(match ? answers[match] : {}),
    };
  });
  return { calls, control };
}

describe("x11KeyChord", () => {
  test("maps friendly names onto xdotool keysyms", () => {
    expect(x11KeyChord("Enter")).toBe("Return");
    expect(x11KeyChord("ctrl+l")).toBe("ctrl+l");
    expect(x11KeyChord("Cmd+Shift+T")).toBe("super+shift+t");
    expect(x11KeyChord("alt+F4")).toBe("alt+F4");
    expect(x11KeyChord("Page_Down")).toBe("Page_Down");
    expect(x11KeyChord("ctrl + c")).toBe("ctrl+c");
  });

  test("refuses anything that is not a keysym", () => {
    expect(() => x11KeyChord("ctrl+l; rm -rf /")).toThrow(/Unsupported key/);
    expect(() => x11KeyChord("")).toThrow(/empty/);
    expect(() => x11KeyChord("$(id)")).toThrow(/Unsupported key/);
  });
});

describe("x11ScreenshotScript", () => {
  test("captures the root window, optionally scaled, as base64", () => {
    expect(x11ScreenshotScript(":0", 1, "png")).toBe(
      "DISPLAY=:0 import -window root png:- | base64 -w0",
    );
    expect(x11ScreenshotScript(":0", 0.67, "jpeg")).toBe(
      "DISPLAY=:0 import -window root -resize 67% -quality 80 jpeg:- | base64 -w0",
    );
  });

  test("only accepts a real display name and a sane scale", () => {
    expect(() => x11ScreenshotScript(":0; id", 1, "png")).toThrow(/display/);
    expect(() => x11ScreenshotScript(":0", 0, "png")).toThrow(/scale/);
    expect(() => x11ScreenshotScript(":0", 2, "png")).toThrow(/scale/);
  });
});

describe("x11DesktopControl", () => {
  test("passes input as argv, never through a shell", async () => {
    const { calls, control } = harness();
    await control.click(10.4, 20.6, { button: "right", double: true });
    await control.type("echo $(id); rm -rf /");
    await control.key("ctrl+l");
    await control.scroll(5, 5, "up", 2);
    await control.drag({ x: 1, y: 2 }, { x: 3, y: 4 });
    expect(calls).toEqual([
      [
        "env",
        "DISPLAY=:0",
        "xdotool",
        "mousemove",
        "10",
        "21",
        "click",
        "--repeat",
        "2",
        "--delay",
        "80",
        "3",
      ],
      [
        "env",
        "DISPLAY=:0",
        "xdotool",
        "type",
        "--delay",
        "12",
        "--",
        "echo $(id); rm -rf /",
      ],
      ["env", "DISPLAY=:0", "xdotool", "key", "--clearmodifiers", "ctrl+l"],
      [
        "env",
        "DISPLAY=:0",
        "xdotool",
        "mousemove",
        "5",
        "5",
        "click",
        "--repeat",
        "2",
        "--delay",
        "30",
        "4",
      ],
      [
        "env",
        "DISPLAY=:0",
        "xdotool",
        "mousemove",
        "1",
        "2",
        "mousedown",
        "1",
        "sleep",
        "0.15",
        "mousemove",
        "3",
        "4",
        "sleep",
        "0.15",
        "mouseup",
        "1",
      ],
    ]);
  });

  test("screenshots report the desktop size alongside the image", async () => {
    const { control } = harness({
      getdisplaygeometry: { stdout: "1920 1080\n" },
      "import -window root": { stdout: "aGVsbG8=\n" },
    });
    expect(await control.screenshot({ scale: 0.5, format: "jpeg" })).toEqual({
      data: "aGVsbG8=",
      mimeType: "image/jpeg",
      width: 1920,
      height: 1080,
    });
  });

  test("surfaces xdotool failures with their stderr", async () => {
    const { control } = harness({
      mousemove: { exitCode: 1, stderr: "Error: Can't open display" },
    });
    await expect(control.move(1, 1)).rejects.toThrow(/Can't open display/);
  });
});

describe("parseX11Windows", () => {
  test("reads the tab-separated listing, marking the active window", () => {
    expect(
      parseX11Windows(
        "1001\t0\t0\t1920\t1080\t0\tDesktop\n1002\t100\t50\t1200\t800\t1\tGitHub - Chromium\n\n",
      ),
    ).toEqual([
      {
        id: "1001",
        title: "Desktop",
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        active: false,
      },
      {
        id: "1002",
        title: "GitHub - Chromium",
        x: 100,
        y: 50,
        width: 1200,
        height: 800,
        active: true,
      },
    ]);
  });
});
