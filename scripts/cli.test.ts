import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test.each(["--help", "-h"])(
  "update %s prints help without running an update",
  async (flag) => {
    const home = mkdtempSync(join(tmpdir(), "opensession-help-test-"));
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("./cli.ts", import.meta.url).pathname,
          "update",
          flag,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            OPENSESSION_HOME: home,
            OPENSESSION_CONFIG: join(home, "config.json"),
            OPENSESSION_ENV_FILE: join(home, "env"),
            // A regression must not reach git/curl or update this checkout.
            PATH: "",
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
      expect(code).toBe(0);
      expect(stdout).toContain("update [--channel <ref>]");
      expect(stdout).not.toContain("working tree has uncommitted changes");
      expect(stdout).not.toContain("fetching");
      expect(stderr).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
