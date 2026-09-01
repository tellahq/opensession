import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const dropInPath = resolve(
  import.meta.dir,
  "systemd/caddy.service.d/opensession.conf",
);

describe("Caddy systemd deployment", () => {
  test("waits for Tailscale and retries a failed tailnet-IP bind", async () => {
    const dropIn = await Bun.file(dropInPath).text();

    expect(dropIn).toContain("After=tailscaled.service");
    expect(dropIn).toContain("Wants=tailscaled.service");
    expect(dropIn).toContain("Restart=on-failure");
    expect(dropIn).toMatch(/^RestartSec=[1-9]\d*s$/m);
  });

  test("the host deploy installs the drop-in", async () => {
    const deployScript = await Bun.file(
      resolve(repoRoot, "deploy/deploy.sh"),
    ).text();

    expect(deployScript).toContain(
      "deploy/systemd/caddy.service.d/opensession.conf",
    );
    expect(deployScript).toContain(
      "/etc/systemd/system/caddy.service.d/opensession.conf",
    );
  });
});
