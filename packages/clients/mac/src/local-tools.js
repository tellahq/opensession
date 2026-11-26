// The model command-line tools the app's own server runs: Claude Code for
// every Claude turn, Codex for ChatGPT sign-in and usage. The app does not
// carry them. A copy already installed on the Mac is used as it is; otherwise
// the app downloads the publisher's own build into its state folder:
//
//   tools/claude/<version>/claude     fetched before the first start
//   tools/claude/current -> <version>
//   tools/codex/<version>/codex       fetched the first time something runs it
//   tools/codex/current -> <version>
//   tools/bin/codex                   a stand-in on PATH that asks for it
//
// A download is the file the publisher serves, checked against the checksum
// they publish and, on a Mac, against their Developer ID. It is never
// modified or re-signed.
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const SOURCES = {
  claude: "https://downloads.claude.ai/claude-code-releases",
  codex: "https://releases.openai.com/codex/channels/latest",
};
// The computers both publishers build for, with Codex's name for each.
const CODEX_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
};
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const METADATA_TIMEOUT_MS = 20_000;
// A download that stops sending is given up on; one that keeps sending may
// take as long as the connection needs.
const STALL_MS = 60_000;
const REFRESH_MS = 24 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;
// Codex is only used to sign in and read usage, so it is not chased release
// by release: a copy is replaced once it is this old.
const CODEX_STALE_MS = 30 * 24 * 60 * 60_000;

class LocalToolError extends Error {}

function versionOf(value, label) {
  const version = String(value || "").trim();
  if (!VERSION.test(version))
    throw new LocalToolError(`${label} did not say which version is current.`);
  return version;
}

function checksumOf(value, label) {
  const checksum = String(value || "");
  if (!SHA256.test(checksum))
    throw new LocalToolError(`${label} has no build for this computer.`);
  return checksum;
}

/** What to fetch for each tool: where the publisher's installer gets it. */
const TOOLS = {
  claude: {
    label: "Claude Code",
    // Developer ID Application: Anthropic PBC
    teamId: "Q6L2SF6YDW",
    async release(source, target, get) {
      const version = versionOf(await get.text(`${source}/latest`), this.label);
      const [packed, plain] = await Promise.all([
        get.json(`${source}/${version}/manifest.zst.json`),
        get.json(`${source}/${version}/manifest.json`),
      ]);
      const entry = packed?.platforms?.[target];
      return {
        version,
        url: `${source}/${version}/${target}/claude.zst`,
        sha256: checksumOf(entry?.checksum, this.label),
        size: Number(entry?.size) || 0,
        binarySha256: checksumOf(
          plain?.platforms?.[target]?.checksum,
          this.label,
        ),
      };
    },
  },
  codex: {
    label: "Codex",
    // Developer ID Application: OpenAI OpCo, LLC
    teamId: "2DC432GLL2",
    onDemand: true,
    async release(source, target, get) {
      const channel = await get.json(source);
      const version = versionOf(
        String(channel?.tag_name || "").replace(/^rust-v/, ""),
        this.label,
      );
      const name = `codex-${CODEX_TARGETS[target]}.zst`;
      const asset = (Array.isArray(channel?.assets) ? channel.assets : []).find(
        (item) => item?.name === name,
      );
      const digest = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest || "");
      const url = String(asset?.browser_download_url || "");
      // The channel names its own files. One that points anywhere else is
      // not followed.
      if (!url.startsWith(`${new URL(source).origin}/`))
        throw new LocalToolError(
          `${this.label} has no build for this computer.`,
        );
      return {
        version,
        url,
        sha256: checksumOf(digest?.[1], this.label),
        size: 0,
      };
    },
  },
};

/** The first executable called `name` in a PATH value, or null. */
function findOnPath(name, pathValue) {
  for (const dir of String(pathValue || "").split(":")) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

/** On a Mac, the file must carry the publisher's Developer ID signature.
 * Elsewhere there is nothing comparable to check. */
function verifySignature(
  file,
  teamId,
  { platform = os.platform(), execFile = childProcess.execFile } = {},
) {
  if (platform !== "darwin") return Promise.resolve();
  const requirement =
    "anchor apple generic" +
    " and certificate 1[field.1.2.840.113635.100.6.2.6] exists" +
    " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" +
    ` and certificate leaf[subject.OU] = "${teamId}"`;
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/codesign",
      ["--verify", "--strict", `-R=${requirement}`, file],
      { timeout: 120_000, encoding: "utf8" },
      (error, _stdout, stderr) =>
        error
          ? reject(
              new LocalToolError(
                `The download is not signed by its publisher: ${String(stderr || error.message).trim()}`,
              ),
            )
          : resolve(),
    );
  });
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** What `codex` on PATH is until the real one has been fetched: it leaves a
 * note for the app, waits for the download, then becomes Codex. */
function standIn(name, label, dir) {
  return `#!/bin/sh
# Written by the Open Session app at every start. ${label} is downloaded the
# first time something runs it.
dir=${quote(dir)}
real="$dir/${name}/current/${name}"
if [ ! -x "$real" ]; then
  rm -f "$dir/${name}.error"
  n=0
  while [ ! -x "$real" ]; do
    if [ -f "$dir/${name}.error" ]; then
      cat "$dir/${name}.error" >&2
      exit 127
    fi
    if [ "$n" -ge 1200 ]; then
      echo "${label} is still downloading. Try again in a minute." >&2
      exit 127
    fi
    [ $((n % 20)) -eq 0 ] && : > "$dir/${name}.wanted"
    n=$((n + 1))
    sleep 0.5
  done
fi
exec "$real" "$@"
`;
}

class LocalTools {
  constructor({
    dir,
    platform = os.platform(),
    arch = os.arch(),
    fetch = globalThis.fetch,
    execFile = childProcess.execFile,
    sources = SOURCES,
    verify = null,
    log = () => {},
  }) {
    this.dir = dir;
    this.target = `${platform}-${arch}`;
    this.fetch = fetch;
    this.sources = sources;
    this.verify =
      verify ||
      ((file, teamId) => verifySignature(file, teamId, { platform, execFile }));
    this.log = log;
    this.jobs = new Map();
    this.managed = new Set();
    this.controller = new AbortController();
    this.watcher = null;
    this.timers = [];
  }

  get binDir() {
    return path.join(this.dir, "bin");
  }

  label(name) {
    return TOOLS[name].label;
  }

  path(name) {
    return path.join(this.dir, name, "current", name);
  }

  /** The version in use, or null when the tool has not been fetched. */
  installed(name) {
    const home = path.join(this.dir, name);
    try {
      const version = fs.readlinkSync(path.join(home, "current"));
      fs.accessSync(path.join(home, version, name), fs.constants.X_OK);
      return version;
    } catch {
      return null;
    }
  }

  /** Put the stand-ins on disk. Called before the server starts, so a note
   * left for a server that is gone is dropped here. */
  prepare() {
    fs.mkdirSync(this.binDir, { recursive: true, mode: 0o700 });
    for (const [name, tool] of Object.entries(TOOLS)) {
      if (!tool.onDemand) continue;
      fs.rmSync(path.join(this.dir, `${name}.wanted`), { force: true });
      fs.rmSync(path.join(this.dir, `${name}.error`), { force: true });
      const file = path.join(this.binDir, name);
      fs.writeFileSync(file, standIn(name, tool.label, this.dir));
      fs.chmodSync(file, 0o755);
    }
  }

  /** Fetch a tool that is missing, or with `update` the current release when
   * it differs from the one in use. Callers asking for the same tool share
   * one download. Resolves with the path to run. */
  ensure(name, { update = false, onProgress } = {}) {
    if (!update && this.installed(name))
      return Promise.resolve(this.path(name));
    let job = this.jobs.get(name);
    if (!job) {
      job = this.obtain(name, onProgress).finally(() => this.jobs.delete(name));
      this.jobs.set(name, job);
    }
    return job;
  }

  async obtain(name, onProgress) {
    const tool = TOOLS[name];
    const { signal } = this.controller;
    if (!CODEX_TARGETS[this.target])
      throw new LocalToolError(`${tool.label} has no build for this computer.`);
    const release = await tool.release(this.sources[name], this.target, {
      text: (url) => this.metadata(url, signal).then((r) => r.text()),
      json: (url) => this.metadata(url, signal).then((r) => r.json()),
    });
    const home = path.join(this.dir, name);
    const previous = this.installed(name);
    if (previous === release.version) {
      // Still current: the next age check counts from now.
      const now = new Date();
      fs.utimesSync(path.join(home, previous), now, now);
      return this.path(name);
    }
    await this.install(name, release, { signal, onProgress });
    this.log(
      previous
        ? `${tool.label} ${previous} replaced by ${release.version}`
        : `${tool.label} ${release.version} downloaded`,
    );
    for (const entry of fs.readdirSync(home)) {
      if (entry === release.version || entry === previous) continue;
      if (VERSION.test(entry))
        fs.rmSync(path.join(home, entry), { recursive: true, force: true });
    }
    return this.path(name);
  }

  async metadata(url, signal) {
    const response = await this.fetch(url, {
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(METADATA_TIMEOUT_MS),
      ]),
    });
    if (!response.ok)
      throw new LocalToolError(
        `${new URL(url).host} answered ${response.status}.`,
      );
    return response;
  }

  async install(name, release, { signal, onProgress }) {
    const tool = TOOLS[name];
    const home = path.join(this.dir, name);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // What an interrupted download left behind.
    for (const entry of fs.readdirSync(home)) {
      if (entry.startsWith(".incoming-"))
        fs.rmSync(path.join(home, entry), { recursive: true, force: true });
    }
    const work = fs.mkdtempSync(path.join(home, ".incoming-"));
    try {
      const packed = path.join(work, `${name}.zst`);
      const sha256 = await this.download(release, packed, signal, onProgress);
      if (sha256 !== release.sha256)
        throw new LocalToolError(
          `${tool.label} ${release.version} did not match its published checksum.`,
        );
      const binary = path.join(work, name);
      const unpacked = crypto.createHash("sha256");
      await pipeline(
        fs.createReadStream(packed),
        zlib.createZstdDecompress(),
        new Transform({
          transform(chunk, _encoding, done) {
            unpacked.update(chunk);
            done(null, chunk);
          },
        }),
        fs.createWriteStream(binary, { mode: 0o755 }),
        { signal },
      );
      if (
        release.binarySha256 &&
        unpacked.digest("hex") !== release.binarySha256
      )
        throw new LocalToolError(
          `${tool.label} ${release.version} did not match its published checksum.`,
        );
      fs.rmSync(packed);
      fs.chmodSync(binary, 0o755);
      await this.verify(binary, tool.teamId);

      const final = path.join(home, release.version);
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(work, final);
      // Swapped in one step, so a run that starts now gets a whole file.
      const link = path.join(home, "current");
      const next = `${link}.next`;
      fs.rmSync(next, { force: true });
      fs.symlinkSync(release.version, next);
      fs.renameSync(next, link);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  async download(release, file, signal, onProgress) {
    const stalled = new AbortController();
    const either = AbortSignal.any([signal, stalled.signal]);
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => stalled.abort(new LocalToolError("The download stalled.")),
        STALL_MS,
      );
    };
    arm();
    try {
      const response = await this.fetch(release.url, { signal: either });
      if (!response.ok || !response.body)
        throw new LocalToolError(
          `${new URL(release.url).host} answered ${response.status}.`,
        );
      const total =
        release.size || Number(response.headers.get("content-length")) || 0;
      const hash = crypto.createHash("sha256");
      let received = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _encoding, done) {
            hash.update(chunk);
            received += chunk.length;
            arm();
            if (onProgress) onProgress(received, total);
            done(null, chunk);
          },
        }),
        fs.createWriteStream(file, { mode: 0o600 }),
        { signal: either },
      );
      return hash.digest("hex");
    } catch (error) {
      throw stalled.signal.aborted ? stalled.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** While the server runs: answer the stand-ins, and keep the tools named
   * in `manage` current. */
  watch({ manage = [] } = {}) {
    this.stop();
    this.managed = new Set(manage);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.watcher = fs.watch(this.dir, () => this.answer());
      this.watcher.on("error", () => {});
    } catch {
      this.every(2_000, () => this.answer());
    }
    this.answer();
    this.every(REFRESH_MS, () => void this.refresh());
    void this.refresh();
  }

  every(ms, run) {
    const timer = setInterval(run, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  /** Stop watching and give up any download under way. */
  stop() {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.controller.abort(new LocalToolError("The download was cancelled."));
    this.controller = new AbortController();
  }

  answer() {
    for (const [name, tool] of Object.entries(TOOLS)) {
      if (!tool.onDemand) continue;
      const wanted = path.join(this.dir, `${name}.wanted`);
      if (!fs.existsSync(wanted)) continue;
      fs.rmSync(wanted, { force: true });
      const { signal } = this.controller;
      this.ensure(name).catch((error) => {
        if (signal.aborted) return;
        const reason = `${tool.label} could not be downloaded: ${error.message}`;
        this.log(reason);
        try {
          fs.writeFileSync(path.join(this.dir, `${name}.error`), `${reason}\n`);
        } catch {}
      });
    }
  }

  async refresh() {
    const { signal } = this.controller;
    let missing = false;
    for (const [name, tool] of Object.entries(TOOLS)) {
      const due = tool.onDemand
        ? this.age(name) > CODEX_STALE_MS
        : this.managed.has(name);
      if (!due) continue;
      try {
        await this.ensure(name, { update: true });
      } catch (error) {
        if (signal.aborted) return;
        this.log(`${tool.label} could not be downloaded: ${error.message}`);
        missing ||= !tool.onDemand && !this.installed(name);
      }
    }
    // A tool the server cannot work without is tried again soon.
    if (!missing || signal.aborted) return;
    const timer = setTimeout(() => void this.refresh(), RETRY_MS);
    timer.unref?.();
    this.timers.push(timer);
  }

  /** How long ago the version in use was fetched or last found current. */
  age(name) {
    const version = this.installed(name);
    if (!version) return 0;
    try {
      return (
        Date.now() - fs.statSync(path.join(this.dir, name, version)).mtimeMs
      );
    } catch {
      return 0;
    }
  }
}

module.exports = {
  LocalTools,
  LocalToolError,
  SOURCES,
  findOnPath,
  verifySignature,
};
