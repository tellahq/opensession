import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configurePrivateAppDomain,
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
  for (const host of ["darwin", "win32"]) {
    test(`${host} rejects setup before tools, credentials, DNS, or ACME`, async () => {
      Object.defineProperty(process, "platform", { value: host });
      await expect(configurePrivateAppDomain(input)).rejects.toThrow(
        "Automatic private-domain setup requires Linux with systemd",
      );
      expect(which).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await readdir(scratch)).toEqual([]);
    });

    test(`${host} leaves externally managed certificate renewal alone`, async () => {
      Object.defineProperty(process, "platform", { value: host });
      expect(await renewPrivateAppCertificate()).toBe(false);
      expect(which).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await readdir(scratch)).toEqual([]);
    });
  }

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
