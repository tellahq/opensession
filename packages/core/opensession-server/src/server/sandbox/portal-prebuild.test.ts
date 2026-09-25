import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
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
    // A free port: a random one is often taken on a busy machine, and the
    // warm-up would then wait on someone else's server.
    const free = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = free.port;
    free.stop(true);
    // A stand-in dev server: records requests, rewrites a tracked file and
    // leaves a port file behind, the way a real one might.
    writeFileSync(
      join(dir, "app.ts"),
      `import { appendFileSync, writeFileSync } from "fs";
writeFileSync("tracked.txt", "rewritten\\n");
writeFileSync(".ports.conf", "WEBAPP_PORT=" + process.env.PORT + "\\n");
// Like Next writing its compile cache on shutdown: slow, and only allowed
// to finish when the server is given the time.
process.on("SIGTERM", () => setTimeout(() => {
  writeFileSync(${JSON.stringify(join(root, "persisted"))}, String(process.env.NEXT_EXIT_TIMEOUT_MS));
  process.exit(0);
}, 1500));
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
    // A Turbopack cache whose last write settled a minute ago: nothing to
    // wait for before stopping the app.
    const cache = join(dir, ".next", "dev", "cache", "turbopack", "v1");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "LOG"), "Commit 1\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(cache, "LOG"), past, past);
    const run = Bun.spawn(["bash", "-c", script], { stdout: "pipe" });
    expect(await run.exited).toBe(0);
    expect(await new Response(run.stdout).text()).toContain(
      "waited 0s for the compile cache to be written",
    );
    // Warmed in parallel, so in either order.
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
    // The app finished its shutdown write, and Next was told to allow it.
    expect(readFileSync(join(root, "persisted"), "utf8")).toBe("300000");
    expect(existsSync(join(dir, ".ports.conf"))).toBe(false);
    expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("original\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
