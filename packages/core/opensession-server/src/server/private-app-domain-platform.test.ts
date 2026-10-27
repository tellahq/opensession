import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as dns from "dns/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  configurePrivateAppDomain,
  privateAppDomainStatus,
  renewPrivateAppCertificate,
} from "./private-app-domain";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalStateDir = process.env.OPENSESSION_STATE_DIR;
const input = {
  domain: "os.example.test",
  provider: "cloudflare" as const,
  email: "acme@example.test",
  apiToken: "synthetic-token",
  tailnetIpv4: "100.64.0.10",
};
let scratch: string;
let lego: string;
let which: ReturnType<typeof spyOn<typeof Bun, "which">>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "private-domain-platform-"));
  process.env.OPENSESSION_STATE_DIR = join(scratch, "state");
  lego = join(scratch, "lego");
  Object.defineProperty(process, "platform", { value: "linux" });
  which = spyOn(Bun, "which").mockImplementation((name) =>
    name === "lego" ? lego : `/synthetic/${name}`,
  );
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("synthetic DNS boundary"),
  );
});

afterEach(async () => {
  which.mockRestore();
  fetchSpy.mockRestore();
  Object.defineProperty(process, "platform", platform);
  if (originalStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = originalStateDir;
  await rm(scratch, { recursive: true, force: true });
});

async function fakeLego(version: string, exitCode = 0) {
  await writeFile(
    lego,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${scratch}/calls'\nprintf '%s\\n' '${version}'\nexit ${exitCode}\n`,
  );
  await chmod(lego, 0o755);
}

describe("private-domain platform and CLI preflight", () => {
  test("unsupported platforms reject setup before tools, credentials, DNS, or ACME", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(configurePrivateAppDomain(input)).rejects.toThrow(
      "Automatic private-domain setup requires Linux with systemd or macOS with Homebrew Caddy",
    );
    expect(which).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readdir(scratch)).toEqual([]);
  });

  test("unsupported platforms leave externally managed certificate renewal alone", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(await renewPrivateAppCertificate()).toBe(false);
    expect(which).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readdir(scratch)).toEqual([]);
  });

  for (const [version, code] of [
    ["lego version 5.4.1 linux/amd64", 0],
    ["another lego CLI", 0],
    ["lego version 4.26.0 linux/amd64", 1],
  ] as const) {
    test(`rejects incompatible CLI (${version}, exit ${code}) before DNS or ACME`, async () => {
      await fakeLego(version, code);
      await expect(configurePrivateAppDomain(input)).rejects.toThrow(
        "requires the official go-acme lego 4.x CLI",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await Bun.file(join(scratch, "calls")).text()).toBe("--version\n");
      expect(await readdir(scratch)).not.toContain("state");
    });
  }

  test("accepts the pinned v4 CLI and continues to DNS setup", async () => {
    await fakeLego("lego version 4.26.0 linux/amd64");
    await expect(configurePrivateAppDomain(input)).rejects.toThrow(
      "synthetic DNS boundary",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await Bun.file(join(scratch, "calls")).text()).toBe("--version\n");
  });

  test("renewal rejects lego 5 before running ACME or touching certificates", async () => {
    await fakeLego("lego version 5.4.1 linux/amd64");
    await mkdir(process.env.OPENSESSION_STATE_DIR!);
    const saved = JSON.stringify({ ...input, version: 1 });
    const credentialPath = join(
      process.env.OPENSESSION_STATE_DIR!,
      ".opensession-private-app-dns.json",
    );
    await writeFile(credentialPath, saved, { mode: 0o600 });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await renewPrivateAppCertificate()).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await Bun.file(join(scratch, "calls")).text()).toBe("--version\n");
      expect(await Bun.file(credentialPath).text()).toBe(saved);
      expect(await readdir(process.env.OPENSESSION_STATE_DIR!)).toEqual([
        ".opensession-private-app-dns.json",
      ]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("automatic private-domain setup on macOS", () => {
  let tools: Record<string, string>;
  let caddyfile: string;
  const originalCaddyfile = process.env.OPENSESSION_CADDYFILE;
  const originalTlsDir = process.env.OPENSESSION_TLS_DIR;

  async function tool(name: string, body: string) {
    const path = join(scratch, "bin", name);
    await writeFile(
      path,
      `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${scratch}/calls'\n${body}\n`,
    );
    await chmod(path, 0o755);
    tools[name] = path;
  }

  /** caddy exits with the code in `${scratch}/caddy-<subcommand>-exit`. */
  async function installTools() {
    await mkdir(join(scratch, "bin"));
    await tool(
      "lego",
      [
        'case "$*" in *--version*) echo "lego version 4.26.0 darwin/arm64"; exit 0;; esac',
        'dir=""; prev=""; for arg in "$@"; do [ "$prev" = "--path" ] && dir="$arg"; prev="$arg"; done',
        'mkdir -p "$dir/certificates"',
        'echo synthetic-certificate > "$dir/certificates/os.example.test.crt"',
        'echo synthetic-key > "$dir/certificates/os.example.test.key"',
      ].join("\n"),
    );
    await tool(
      "caddy",
      `code=$(cat '${scratch}/caddy-'"$1"'-exit' 2>/dev/null || echo 0); [ "$code" = 0 ] || echo "caddy $1 failed" >&2; exit $code`,
    );
    await tool(
      "brew",
      `[ "$1" = --prefix ] && echo '${scratch}/homebrew' && exit 0; exit $(cat '${scratch}/brew-exit' 2>/dev/null || echo 0)`,
    );
  }

  beforeEach(async () => {
    tools = {};
    delete process.env.OPENSESSION_CADDYFILE;
    delete process.env.OPENSESSION_TLS_DIR;
    Object.defineProperty(process, "platform", { value: "darwin" });
    caddyfile = join(scratch, "homebrew", "etc", "Caddyfile");
    await installTools();
    which.mockImplementation((name) => tools[name] ?? null);
    fetchSpy.mockImplementation((async (url: string | URL | Request) => {
      const path = String(url);
      const result = path.includes("/zones?")
        ? [{ id: "zone", name: "example.test" }]
        : path.includes("/dns_records?")
          ? []
          : {};
      return Response.json({ success: true, result });
    }) as typeof fetch);
  });

  afterEach(() => {
    if (originalCaddyfile === undefined)
      delete process.env.OPENSESSION_CADDYFILE;
    else process.env.OPENSESSION_CADDYFILE = originalCaddyfile;
    if (originalTlsDir === undefined) delete process.env.OPENSESSION_TLS_DIR;
    else process.env.OPENSESSION_TLS_DIR = originalTlsDir;
  });

  const calls = async () =>
    (await Bun.file(join(scratch, "calls")).text()).trim().split("\n");

  test("writes the Homebrew Caddyfile without sudo, reloads Caddy, and saves the credential", async () => {
    await mkdir(join(scratch, "homebrew", "etc"), { recursive: true });
    await writeFile(caddyfile, "example.net {\n    respond ok\n}\n");

    await configurePrivateAppDomain(input);

    const config = await Bun.file(caddyfile).text();
    expect(config).toStartWith("example.net {\n    respond ok\n}\n");
    expect(config).not.toContain("bind ");
    expect(config).toContain("https://os.example.test {");
    expect(config).toContain("http://os.example.test {");
    expect(
      config.match(
        /@outside_tailnet not remote_ip 100\.64\.0\.0\/10 fd7a:115c:a1e0::\/48/g,
      ),
    ).toHaveLength(2);
    expect(config).toContain("redir https://{host}{uri} permanent");
    const tls = config.match(/^\s*tls (\S+) (\S+)$/m)!;
    expect(tls[1]).toStartWith(process.env.OPENSESSION_STATE_DIR!);
    expect(await Bun.file(tls[1]).text()).toBe("synthetic-certificate\n");
    expect((await stat(tls[2])).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(tls[2]))).mode & 0o777).toBe(0o700);

    expect(await calls()).toEqual([
      "lego --version",
      expect.stringMatching(/^lego --path .* --domains os\.example\.test run$/),
      "brew --prefix",
      `caddy validate --config ${caddyfile} --adapter caddyfile`,
      `caddy reload --config ${caddyfile} --adapter caddyfile`,
    ]);
    expect(which).not.toHaveBeenCalledWith("sudo");
    const credential = join(
      process.env.OPENSESSION_STATE_DIR!,
      ".opensession-private-app-dns.json",
    );
    expect(JSON.parse(await Bun.file(credential).text())).toMatchObject({
      domain: "os.example.test",
      provider: "cloudflare",
    });
    expect((await stat(credential)).mode & 0o777).toBe(0o600);
    const status = await privateAppDomainStatus(
      "https://os.example.test",
      null,
    );
    expect(status.credentialConfigured).toBe(true);
  });

  test("creates a missing Homebrew Caddyfile and restarts the Homebrew service when reload fails", async () => {
    await writeFile(join(scratch, "caddy-reload-exit"), "1");

    await configurePrivateAppDomain(input);

    expect(await Bun.file(caddyfile).text()).toStartWith(
      "https://os.example.test {",
    );
    expect((await calls()).slice(-2)).toEqual([
      `caddy reload --config ${caddyfile} --adapter caddyfile`,
      "brew services restart caddy",
    ]);
  });

  test("restores the prior Caddyfile and saves no credential when Caddy cannot be reloaded", async () => {
    await mkdir(join(scratch, "homebrew", "etc"), { recursive: true });
    await writeFile(caddyfile, "example.net {\n    respond ok\n}\n");
    await writeFile(join(scratch, "caddy-reload-exit"), "1");
    await writeFile(join(scratch, "brew-exit"), "1");

    await expect(configurePrivateAppDomain(input)).rejects.toThrow(
      "brew services start caddy",
    );
    expect(await Bun.file(caddyfile).text()).toBe(
      "example.net {\n    respond ok\n}\n",
    );
    expect(await readdir(process.env.OPENSESSION_STATE_DIR!)).not.toContain(
      ".opensession-private-app-dns.json",
    );
  });

  test("renews and reinstalls the certificate for a managed Homebrew Caddy", async () => {
    await mkdir(join(scratch, "homebrew", "etc"), { recursive: true });
    await writeFile(caddyfile, "");
    await configurePrivateAppDomain(input);
    await writeFile(join(scratch, "calls"), "");
    const resolver = spyOn(dns, "resolve4").mockResolvedValue([
      input.tailnetIpv4,
    ]);
    await writeFile(
      tools.lego,
      (await Bun.file(tools.lego).text()).replace(
        "synthetic-certificate",
        "renewed-certificate",
      ),
    );
    try {
      expect(await renewPrivateAppCertificate()).toBe(true);
    } finally {
      resolver.mockRestore();
    }
    const tls = (await Bun.file(caddyfile).text()).match(/tls (\S+) /)!;
    expect(await Bun.file(tls[1]).text()).toBe("renewed-certificate\n");
    expect((await calls()).at(-1)).toBe(
      `caddy reload --config ${caddyfile} --adapter caddyfile`,
    );
  });

  const legacyWithUnmanagedHttp =
    "os.example.test {\n    # BEGIN OPENSESSION PRIVATE APP\n    reverse_proxy 127.0.0.1:3850\n    # END OPENSESSION PRIVATE APP\n}\n\nhttp://os.example.test {\n    respond mine\n}\n";

  test("setup refuses an unmanaged HTTP site next to a managed HTTPS site", async () => {
    await mkdir(join(scratch, "homebrew", "etc"), { recursive: true });
    await writeFile(caddyfile, legacyWithUnmanagedHttp);
    await expect(configurePrivateAppDomain(input)).rejects.toThrow(
      "unmanaged Caddy site",
    );
    expect(await Bun.file(caddyfile).text()).toBe(legacyWithUnmanagedHttp);
    expect(await calls()).not.toContainEqual(
      expect.stringMatching(/^caddy (validate|reload)/),
    );
    expect(await readdir(process.env.OPENSESSION_STATE_DIR!)).not.toContain(
      ".opensession-private-app-dns.json",
    );
  });

  test("renewal refuses an unmanaged HTTP site next to a managed HTTPS site", async () => {
    await mkdir(join(scratch, "homebrew", "etc"), { recursive: true });
    await writeFile(caddyfile, legacyWithUnmanagedHttp);
    await mkdir(process.env.OPENSESSION_STATE_DIR!);
    await writeFile(
      join(
        process.env.OPENSESSION_STATE_DIR!,
        ".opensession-private-app-dns.json",
      ),
      JSON.stringify({ ...input, version: 1 }),
      { mode: 0o600 },
    );
    const resolver = spyOn(dns, "resolve4").mockResolvedValue([
      input.tailnetIpv4,
    ]);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await renewPrivateAppCertificate()).toBe(false);
      expect(String(error.mock.calls[0]?.[1])).toContain(
        "unmanaged Caddy site",
      );
    } finally {
      resolver.mockRestore();
      error.mockRestore();
    }
    expect(await Bun.file(caddyfile).text()).toBe(legacyWithUnmanagedHttp);
    expect(await calls()).not.toContainEqual(
      expect.stringMatching(/^caddy (validate|reload)/),
    );
  });

  test("renewal leaves a hand-managed macOS Caddy alone", async () => {
    await mkdir(join(scratch, "homebrew", "etc"), { recursive: true });
    await writeFile(caddyfile, "https://os.example.test {\n}\n");
    await mkdir(process.env.OPENSESSION_STATE_DIR!);
    await writeFile(
      join(
        process.env.OPENSESSION_STATE_DIR!,
        ".opensession-private-app-dns.json",
      ),
      JSON.stringify({ ...input, version: 1 }),
      { mode: 0o600 },
    );
    expect(await renewPrivateAppCertificate()).toBe(false);
    expect(await calls()).toEqual(["brew --prefix"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
