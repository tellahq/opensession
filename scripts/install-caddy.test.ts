import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = await Bun.file(join(import.meta.dir, "../install.sh")).text();
// Execute the real package helper and optional ingress block, without running
// the installer against this host's service, package manager, or home directory.
const packageHelper = installer.slice(
  installer.indexOf("install_package() {"),
  installer.indexOf("# cmd -> package name"),
);
const caddyBlock = installer.slice(
  installer.indexOf('if [ "$WITH_CADDY" = "1" ]; then'),
  installer.indexOf('if [ "$WITH_CLOUDFLARE" = "1" ]; then'),
);

async function runInstaller(options: {
  os: "Darwin" | "Linux";
  arch: string;
  brew?: boolean;
  caddy?: boolean;
  version?: string;
  downloadFails?: boolean;
}) {
  const scratch = await mkdtemp(join(tmpdir(), "install-caddy-"));
  const bin = join(scratch, "bin");
  const home = join(scratch, "home");
  const archive = join(scratch, "lego.tar.gz");
  const downloads = join(scratch, "downloads");
  const brewCalls = join(scratch, "brew-calls");
  async function executable(path: string, body: string) {
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  }
  try {
    await mkdir(bin);
    await mkdir(home);
    for (const name of [
      "mkdir",
      "mktemp",
      "tar",
      "gzip",
      "install",
      "rm",
      "head",
      "cp",
    ]) {
      const source = Bun.which(name);
      if (!source) throw new Error(`Missing fixture tool: ${name}`);
      await symlink(source, join(bin, name));
    }
    await executable(join(bin, "uname"), `echo '${options.arch}'`);
    // A package-manager lego already on PATH must not suppress the pinned build.
    await executable(join(bin, "lego"), "echo 'lego version 5.4.1'");
    await executable(join(scratch, "lego"), "echo 'lego version 4.26.0'");
    const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", scratch, "lego"]);
    expect(tar.exitCode).toBe(0);
    await executable(
      join(bin, "curl"),
      `printf '%s\\n' "$2" >> "$DOWNLOADS"\n${options.downloadFails ? "exit 1" : 'cp "$ARCHIVE" "$4"'}`,
    );
    if (options.caddy)
      await executable(join(bin, "caddy"), "echo 'Caddy fixture'");
    if (options.brew) {
      await executable(
        join(bin, "brew"),
        `printf '%s\\n' "$*" >> "$BREW_CALLS"\n[ "$3" = caddy ] || exit 1\nprintf '#!/bin/sh\\necho Caddy fixture\\n' > "$FIXTURE_BIN/caddy"\n/bin/chmod +x "$FIXTURE_BIN/caddy"`,
      );
    }
    const child = Bun.spawn(
      [
        "/bin/bash",
        "-c",
        `set -eu
warn() { printf '%s\\n' "$*"; }
muted() { printf '%s\\n' "$*"; }
good() { printf '%s\\n' "$*"; }
${packageHelper}
${caddyBlock}
printf 'selected: %s\\n' "$(command -v lego)"
`,
      ],
      {
        env: {
          HOME: home,
          PATH: bin,
          TMPDIR: scratch,
          OS: options.os,
          WITH_CADDY: "1",
          LEGO_VERSION: options.version || "",
          ARCHIVE: archive,
          DOWNLOADS: downloads,
          BREW_CALLS: brewCalls,
          FIXTURE_BIN: bin,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return {
      stdout,
      downloads: await Bun.file(downloads)
        .text()
        .catch(() => ""),
      brewCalls: await Bun.file(brewCalls)
        .text()
        .catch(() => ""),
      installed: await Bun.file(join(home, ".local/bin/lego")).exists(),
      selectedPinned: stdout.includes(`selected: ${home}/.local/bin/lego`),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

for (const [os, arch, target] of [
  ["Darwin", "arm64", "darwin_arm64"],
  ["Darwin", "x86_64", "darwin_amd64"],
  ["Linux", "aarch64", "linux_arm64"],
  ["Linux", "x86_64", "linux_amd64"],
] as const) {
  test(`installs official lego 4.26.0 on ${os}/${arch} ahead of an existing lego 5`, async () => {
    const result = await runInstaller({
      os,
      arch,
      brew: os === "Darwin",
      caddy: os === "Linux",
    });
    expect(result.downloads).toBe(
      `https://github.com/go-acme/lego/releases/download/v4.26.0/lego_v4.26.0_${target}.tar.gz\n`,
    );
    expect(result.brewCalls).toBe(
      os === "Darwin" ? "install --quiet caddy\n" : "",
    );
    expect(result.installed).toBe(true);
    expect(result.selectedPinned).toBe(true);
    expect(result.stdout).toContain("lego version 4.26.0");
    if (os === "Darwin")
      expect(result.stdout).toContain(
        "Automatic private-domain setup requires Linux with systemd",
      );
  });
}

test("missing Homebrew gives actionable Caddy diagnostics without blocking the lego download", async () => {
  const result = await runInstaller({ os: "Darwin", arch: "arm64" });
  expect(result.stdout).toContain(
    "Homebrew is required to install caddy automatically on macOS",
  );
  expect(result.stdout).toContain("https://brew.sh");
  expect(result.stdout).toContain("could not install Caddy automatically");
  expect(result.installed).toBe(true);
});

test("rejects a lego 5 version override instead of installing an unsupported CLI", async () => {
  const result = await runInstaller({
    os: "Darwin",
    arch: "arm64",
    caddy: true,
    version: "5.4.1",
  });
  expect(result.stdout).toContain("LEGO_VERSION must select lego 4.x");
  expect(result.downloads).toBe("");
  expect(result.installed).toBe(false);
});

test("failed download reports the official v4 manual installation path", async () => {
  const result = await runInstaller({
    os: "Darwin",
    arch: "arm64",
    caddy: true,
    downloadFails: true,
  });
  expect(result.stdout).toContain(
    "could not install the official lego build automatically",
  );
  expect(result.stdout).toContain(
    "install lego 4.x from https://go-acme.github.io/lego/installation/",
  );
  expect(result.installed).toBe(false);
  expect(result.selectedPinned).toBe(false);
});
