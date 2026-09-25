import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { portalPrebuildScript } from "./portal-prebuild";

test("compiles the warm routes, stops the app, and leaves the checkout clean", async () => {
  const root = mkdtempSync(join(tmpdir(), "portal-prebuild-"));
  try {
    const dir = join(root, "repo");
    const lifecycleDir = join(root, "lifecycle");
    mkdirSync(dir);
    const git = (args: string) =>
      Bun.spawnSync(["bash", "-c", `git ${args}`], { cwd: dir });
    git("init -q");
    writeFileSync(join(dir, "tracked.txt"), "original\n");
    git(
      "add . && git -c user.email=a@example.test -c user.name=a commit -qm init",
    );
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    // A stand-in dev server: records requests, rewrites a tracked file and
    // leaves a port file behind, the way a real one might.
    writeFileSync(
      join(dir, "app.ts"),
      `import { appendFileSync, writeFileSync } from "fs";
writeFileSync("tracked.txt", "rewritten\\n");
writeFileSync(".ports.conf", "WEBAPP_PORT=" + process.env.PORT + "\\n");
Bun.serve({ port: Number(process.env.PORT), fetch(req) {
  appendFileSync(${JSON.stringify(join(root, "hits"))}, new URL(req.url).pathname + " " + process.env.SECRET_FOR_TEST + "\\n");
  return new Response("ok");
} });`,
    );
    const script = portalPrebuildScript({
      dir,
      layout: { home: root, path: process.env.PATH!, lifecycleDir },
      name: "app",
      command: `${process.execPath} app.ts`,
      port,
      host: "portals.example.test",
      routes: ["/a", "/b"],
      env: { SECRET_FOR_TEST: "handed-over" },
    });
    const run = Bun.spawn(["bash", "-c", script], { stdout: "pipe" });
    expect(await run.exited).toBe(0);
    // Independent routes warm concurrently; arrival order is not a contract.
    expect(
      readFileSync(join(root, "hits"), "utf8").trim().split("\n").sort(),
    ).toEqual(["/a handed-over", "/b handed-over"]);
    // Stopped, cleaned, and the tracked file is back.
    const probe = Bun.spawnSync([
      "bash",
      "-c",
      `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo open || echo closed`,
    ]);
    expect(probe.stdout.toString().trim()).toBe("closed");
    expect(existsSync(join(dir, ".ports.conf"))).toBe(false);
    expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("original\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
