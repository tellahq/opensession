import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("refresh-file atomically supplies a current token", async () => {
  const token = "sandbox-test-token";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe(
        "Bearer exchange-lease",
      );
      return new Response(token);
    },
  });
  const directory = mkdtempSync(join(tmpdir(), "opensession-id-token-"));
  const file = join(directory, "token");
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/workload-identity-client.ts",
      "sandbox",
      "id-token",
      "--audience",
      "urn:test",
      "--refresh-file",
      file,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENSESSION_WORKLOAD_IDENTITY_URL: `http://127.0.0.1:${server.port}/token`,
        OPENSESSION_WORKLOAD_IDENTITY_TOKEN: "exchange-lease",
      },
    },
  );

  try {
    for (let attempts = 0; attempts < 50; attempts += 1) {
      try {
        if (readFileSync(file, "utf8").trim() === token) break;
      } catch {}
      await Bun.sleep(20);
    }
    expect(readFileSync(file, "utf8").trim()).toBe(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    child.kill();
    await child.exited;
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
