import { describe, expect, test } from "bun:test";
import {
  macChordCommands,
  macDesktopControl,
  parseDesktopBounds,
  parseMacWindows,
} from "./macos-desktop";

describe("macOS key chords", () => {
  test("plain keys type, named keys press", () => {
    expect(macChordCommands("a")).toEqual(["t:a"]);
    expect(macChordCommands("Return")).toEqual(["kp:return"]);
    expect(macChordCommands("enter")).toEqual(["kp:return"]);
    expect(macChordCommands("F5")).toEqual(["kp:f5"]);
  });

  test("modifiers are held around the key", () => {
    expect(macChordCommands("cmd+shift+t")).toEqual([
      "kd:cmd,shift",
      "t:t",
      "ku:cmd,shift",
    ]);
    expect(macChordCommands("ctrl+l")).toEqual(["kd:ctrl", "t:l", "ku:ctrl"]);
    expect(macChordCommands("alt+Left")).toEqual([
      "kd:alt",
      "kp:arrow-left",
      "ku:alt",
    ]);
  });

  test("rejects unknown and empty chords", () => {
    expect(() => macChordCommands("")).toThrow(/empty/);
    expect(() => macChordCommands("cmd+")).toThrow(/no key/);
    expect(() => macChordCommands("foo")).toThrow(/unknown key/);
    expect(() => macChordCommands("a+b")).toThrow(/two keys/);
  });
});

describe("macOS desktop parsing", () => {
  test("reads the Finder desktop bounds", () => {
    expect(parseDesktopBounds("0, 0, 1024, 768\n")).toEqual({
      width: 1024,
      height: 768,
    });
    expect(parseDesktopBounds("nope")).toBeNull();
  });

  test("reads the window list", () => {
    const windows = parseMacWindows(
      "Finder\tDesktop\t0\t0\t1024\t768\t0\nSimulator\tiPhone 17\t100\t50\t400\t800\t1\n",
    );
    expect(windows).toHaveLength(2);
    expect(windows[1]).toEqual({
      id: "Simulator:iPhone 17:100,50",
      title: "iPhone 17 (Simulator)",
      x: 100,
      y: 50,
      width: 400,
      height: 800,
      active: true,
    });
  });
});

describe("macOS desktop control", () => {
  test("drives cliclick and screencapture over exec", async () => {
    const calls: string[][] = [];
    const control = macDesktopControl(async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === "osascript")
        return { exitCode: 0, stdout: "0, 0, 1280, 800", stderr: "" };
      if (cmd[0] === "base64")
        return { exitCode: 0, stdout: "AAAA\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await control.click(10, 20, { button: "right" });
    await control.click(10, 20, { double: true });
    await control.drag({ x: 1, y: 2 }, { x: 3, y: 4 });
    await control.key("cmd+q");
    const shot = await control.screenshot({ scale: 0.5 });
    expect(shot).toEqual({
      data: "AAAA",
      mimeType: "image/png",
      width: 1280,
      height: 800,
    });
    expect(calls).toContainEqual(["cliclick", "rc:10,20"]);
    expect(calls).toContainEqual(["cliclick", "dc:10,20"]);
    expect(calls).toContainEqual(["cliclick", "dd:1,2", "dm:3,4", "du:3,4"]);
    expect(calls).toContainEqual(["cliclick", "kd:cmd", "t:q", "ku:cmd"]);
    expect(calls).toContainEqual([
      "sips",
      "--resampleWidth",
      "640",
      "/tmp/opensession-desktop.png",
    ]);
  });

  test("a failing tool surfaces its stderr", async () => {
    const control = macDesktopControl(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "cliclick: not found",
    }));
    await expect(control.type("hi")).rejects.toThrow(/cliclick: not found/);
  });
});
