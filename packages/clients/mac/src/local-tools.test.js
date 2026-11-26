const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { LocalTools, findOnPath, verifySignature } = require("./local-tools");

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
// A tool that says who it is and what it was asked.
const program = (name, version) =>
  Buffer.from(`#!/bin/sh\necho "${name} ${version} $*"\n`);

let base;
let dir;
let site;
let origin;
// What the two publishers serve, and what was asked of them.
let published;
let requests;

/** Publish a release the way each publisher lays it out. */
function publish({ claude, codex, tamper = {} }) {
  published = {};
  if (claude) {
    const plain = program("claude", claude);
    const packed = zlib.zstdCompressSync(plain);
    published["/claude/latest"] = `${claude}\n`;
    published[`/claude/${claude}/manifest.zst.json`] = JSON.stringify({
      platforms: {
        "darwin-arm64": {
          checksum: tamper.packed || sha256(packed),
          size: packed.length,
        },
      },
    });
    published[`/claude/${claude}/manifest.json`] = JSON.stringify({
      platforms: {
        "darwin-arm64": { checksum: tamper.plain || sha256(plain) },
      },
    });
    published[`/claude/${claude}/darwin-arm64/claude.zst`] = packed;
  }
  if (codex) {
    const packed = zlib.zstdCompressSync(program("codex", codex));
    const name = "codex-aarch64-apple-darwin.zst";
    published["/codex/channels/latest"] = JSON.stringify({
      tag_name: `rust-v${codex}`,
      assets: [
        {
          name,
          digest: `sha256:${sha256(packed)}`,
          browser_download_url:
            tamper.url || `${origin}/codex/releases/${codex}/${name}`,
        },
      ],
    });
    published[`/codex/releases/${codex}/${name}`] = packed;
  }
}

function make(overrides = {}) {
  const tools = new LocalTools({
    dir,
    platform: "darwin",
    arch: "arm64",
    sources: {
      claude: `${origin}/claude`,
      codex: `${origin}/codex/channels/latest`,
    },
    verify: async () => {},
    ...overrides,
  });
  made.push(tools);
  return tools;
}
let made;

function run(file, args = []) {
  return new Promise((resolve) => {
    childProcess.execFile(
      file,
      args,
      { encoding: "utf8", timeout: 20_000 },
      (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "os1-local-tools-"));
  dir = path.join(base, "tools");
  made = [];
  requests = [];
  published = {};
  site = http.createServer((req, res) => {
    requests.push(req.url);
    const body = published[req.url];
    if (body === undefined) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${site.address().port}`;
});

afterEach(async () => {
  for (const tools of made) tools.stop();
  await new Promise((resolve) => site.close(resolve));
  fs.rmSync(base, { recursive: true, force: true });
});

describe("LocalTools", () => {
  test("downloads Claude Code as published and checks who signed it", async () => {
    publish({ claude: "9.9.1" });
    const checked = [];
    const tools = make({
      verify: async (file, teamId) => checked.push([file, teamId]),
    });
    expect(tools.installed("claude")).toBe(null);

    const progress = [];
    const file = await tools.ensure("claude", {
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(file).toBe(path.join(dir, "claude", "current", "claude"));
    expect(tools.installed("claude")).toBe("9.9.1");
    expect((await run(file, ["--version"])).stdout).toBe(
      "claude 9.9.1 --version\n",
    );
    const [done, total] = progress.at(-1);
    expect(done).toBe(total);
    expect(total).toBeGreaterThan(0);
    // Anthropic's Developer ID team, checked on the file before it is used.
    expect(checked).toEqual([
      [expect.stringMatching(/\.incoming-.*\/claude$/), "Q6L2SF6YDW"],
    ]);
    expect(fs.readdirSync(path.join(dir, "claude")).sort()).toEqual([
      "9.9.1",
      "current",
    ]);

    // Asking again costs nothing.
    requests.length = 0;
    await tools.ensure("claude");
    expect(requests).toEqual([]);
  });

  test("refuses a download that does not match its checksum", async () => {
    for (const tamper of [
      { packed: "0".repeat(64) },
      { plain: "0".repeat(64) },
    ]) {
      publish({ claude: "9.9.1", tamper });
      const tools = make();
      await expect(tools.ensure("claude")).rejects.toThrow(
        /did not match its published checksum/,
      );
      expect(tools.installed("claude")).toBe(null);
      expect(fs.readdirSync(path.join(dir, "claude"))).toEqual([]);
    }
  });

  test("refuses a download its publisher did not sign", async () => {
    publish({ claude: "9.9.1" });
    const tools = make({
      verify: async () => {
        throw new Error("The download is not signed by its publisher");
      },
    });
    await expect(tools.ensure("claude")).rejects.toThrow(/not signed/);
    expect(tools.installed("claude")).toBe(null);
    expect(fs.readdirSync(path.join(dir, "claude"))).toEqual([]);
  });

  test("moves to a newer release and keeps one older copy", async () => {
    const tools = make();
    for (const version of ["9.9.1", "9.9.2", "9.9.3"]) {
      publish({ claude: version });
      await tools.ensure("claude", { update: true });
      expect(tools.installed("claude")).toBe(version);
    }
    // 9.9.2 may still be running a turn.
    expect(fs.readdirSync(path.join(dir, "claude")).sort()).toEqual([
      "9.9.2",
      "9.9.3",
      "current",
    ]);
    expect((await run(tools.path("claude"))).stdout).toBe("claude 9.9.3 \n");

    // Nothing new: no download.
    requests.length = 0;
    await tools.ensure("claude", { update: true });
    expect(requests.some((url) => url.endsWith(".zst"))).toBe(false);
  });

  test("an interrupted download leaves the copy in use alone", async () => {
    publish({ claude: "9.9.1" });
    const tools = make();
    await tools.ensure("claude");
    publish({ claude: "9.9.2" });
    delete published["/claude/9.9.2/darwin-arm64/claude.zst"];
    await expect(tools.ensure("claude", { update: true })).rejects.toThrow(
      /answered 404/,
    );
    expect(tools.installed("claude")).toBe("9.9.1");
    expect(fs.readdirSync(path.join(dir, "claude")).sort()).toEqual([
      "9.9.1",
      "current",
    ]);
  });

  test("does not follow a Codex file that lives somewhere else", async () => {
    publish({
      codex: "0.5.0",
      tamper: { url: "https://example.test/codex-aarch64-apple-darwin.zst" },
    });
    await expect(make().ensure("codex")).rejects.toThrow(/no build/);
  });

  test("says so on a computer neither publisher builds for", async () => {
    publish({ claude: "9.9.1" });
    await expect(make({ arch: "riscv64" }).ensure("claude")).rejects.toThrow(
      /no build for this computer/,
    );
  });
});

describe("Codex on PATH", () => {
  test("is fetched the first time something runs it, then is Codex", async () => {
    publish({ codex: "0.5.0" });
    const tools = make();
    tools.prepare();
    tools.watch();
    const codex = path.join(tools.binDir, "codex");
    // Nothing is downloaded until it is asked for.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requests).toEqual([]);

    const first = await run(codex, ["login", "--device-auth"]);
    expect(first).toEqual({
      code: 0,
      stdout: "codex 0.5.0 login --device-auth\n",
      stderr: "",
    });
    expect(tools.installed("codex")).toBe("0.5.0");

    requests.length = 0;
    expect((await run(codex, ["app-server"])).stdout).toBe(
      "codex 0.5.0 app-server\n",
    );
    expect(requests).toEqual([]);
  });

  test("says why when the download fails, and works on the next try", async () => {
    const tools = make();
    tools.prepare();
    tools.watch();
    const codex = path.join(tools.binDir, "codex");

    const failed = await run(codex, ["login"]);
    expect(failed.code).toBe(127);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toMatch(/^Codex could not be downloaded: .*404/);

    publish({ codex: "0.5.0" });
    expect((await run(codex, ["login"])).stdout).toBe("codex 0.5.0 login\n");
  });

  test("a copy a month old is replaced, a newer one is left alone", async () => {
    publish({ codex: "0.5.0" });
    const tools = make();
    await tools.ensure("codex");
    publish({ codex: "0.6.0" });
    await tools.refresh();
    expect(tools.installed("codex")).toBe("0.5.0");

    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    fs.utimesSync(path.join(dir, "codex", "0.5.0"), old, old);
    await tools.refresh();
    expect(tools.installed("codex")).toBe("0.6.0");
  });
});

describe("keeping Claude Code current", () => {
  test("only a copy the app manages is replaced", async () => {
    publish({ claude: "9.9.1" });
    const tools = make();
    await tools.ensure("claude");
    publish({ claude: "9.9.2" });

    // The Mac has its own Claude Code: the app's old copy is not touched.
    tools.watch();
    await tools.refresh();
    expect(tools.installed("claude")).toBe("9.9.1");

    tools.watch({ manage: ["claude"] });
    await tools.refresh();
    expect(tools.installed("claude")).toBe("9.9.2");
  });
});

describe("a tool on the Mac's own PATH", () => {
  test("is the first executable of that name", () => {
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    fs.mkdirSync(path.join(a, "claude"), { recursive: true });
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, "claude"), "", { mode: 0o755 });
    fs.writeFileSync(path.join(b, "codex"), "", { mode: 0o644 });
    const value = `${path.join(base, "missing")}::${a}:${b}`;
    expect(findOnPath("claude", value)).toBe(path.join(b, "claude"));
    expect(findOnPath("codex", value)).toBe(null);
    expect(findOnPath("claude", "")).toBe(null);
  });
});

describe("the publisher's signature", () => {
  test("is checked with codesign on a Mac, against the publisher's team", async () => {
    const ran = [];
    const execFile = (file, args, _options, done) => {
      ran.push([file, ...args]);
      done(null, "", "");
    };
    await verifySignature("/tmp/claude", "Q6L2SF6YDW", {
      platform: "darwin",
      execFile,
    });
    expect(ran).toHaveLength(1);
    expect(ran[0].slice(0, 3)).toEqual([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
    ]);
    expect(ran[0][3]).toMatch(
      /^-R=anchor apple generic .* certificate leaf\[subject\.OU\] = "Q6L2SF6YDW"$/,
    );
    expect(ran[0][4]).toBe("/tmp/claude");

    await expect(
      verifySignature("/tmp/claude", "Q6L2SF6YDW", {
        platform: "darwin",
        execFile: (_file, _args, _options, done) =>
          done(new Error("exit 3"), "", "code failed to satisfy requirement"),
      }),
    ).rejects.toThrow(/not signed by its publisher: code failed to satisfy/);
  });

  test("has nothing to check elsewhere", async () => {
    await verifySignature("/tmp/claude", "Q6L2SF6YDW", {
      platform: "linux",
      execFile: () => {
        throw new Error("should not run");
      },
    });
  });
});
