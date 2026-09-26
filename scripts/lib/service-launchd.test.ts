/** Opt-in macOS integration: only creates disposable jobs, never installed services.
 * OPENSESSION_TEST_LAUNCHD=1 bun test scripts/lib/service-launchd.test.ts
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { bootoutLaunchAgent, controlLaunchd } from "./service";
import { run } from "./ui";

test.skipIf(
  process.platform !== "darwin" || process.env.OPENSESSION_TEST_LAUNCHD !== "1",
)(
  "real launchd: delayed exit, restart, and stop/start",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "opensession-launchd-test-"));
    const id = crypto.randomUUID();
    const gateway = {
      label: `dev.opensession.acme-test.${id}.gateway`,
      plist: join(dir, "gateway.plist"),
    };
    const kernel = {
      label: `dev.opensession.acme-test.${id}.kernel`,
      plist: join(dir, "kernel.plist"),
    };
    const domain = `gui/${process.getuid!()}`;
    const escape = (s: string) =>
      s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    const job = join(dir, "job.ts");
    await Bun.write(
      job,
      `import { writeFileSync } from "fs";
process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 2000); });
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    const ready = async (name: string, oldPid = "") => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const pid = await Bun.file(join(dir, name + ".pid"))
          .text()
          .catch(() => "");
        if (pid && pid !== oldPid) return pid;
        await Bun.sleep(100);
      }
      throw new Error("Disposable job did not start");
    };
    try {
      for (const [name, spec] of [
        ["gateway", gateway],
        ["kernel", kernel],
      ] as const) {
        await Bun.write(
          spec.plist,
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${spec.label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(job)}</string><string>${escape(join(dir, name + ".pid"))}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ExitTimeOut</key><integer>10</integer>
</dict></plist>`,
        );
      }
      const opts = { domain, gateway, kernel, unloadTimeoutMs: 15_000 };
      expect((await controlLaunchd("start", opts)).code).toBe(0);
      const pid = await ready("gateway");
      await ready("kernel");
      // Reproduce the old sequence while the synthetic gateway drains.
      expect(
        (await run(["launchctl", "bootout", `${domain}/${gateway.label}`]))
          .code,
      ).toBe(0);
      const raced = await run([
        "launchctl",
        "bootstrap",
        domain,
        gateway.plist,
      ]);
      expect(raced.code).toBe(5);
      expect(raced.stderr).toContain("Input/output error");
      // A rollback/retry must wait for that same draining job, not accept it.
      expect((await controlLaunchd("restart", opts)).code).toBe(0);
      const restarted = await ready("gateway", pid);
      expect(restarted).not.toBe(pid);
      // Also exercise a fresh restart through the fixed path.
      expect((await controlLaunchd("restart", opts)).code).toBe(0);
      await ready("gateway", restarted);
      expect((await controlLaunchd("stop", opts)).code).toBe(0);
      for (const spec of [gateway, kernel])
        expect(
          (await run(["launchctl", "print", `${domain}/${spec.label}`])).code,
        ).toBe(113);
      expect((await controlLaunchd("start", opts)).code).toBe(0);
    } finally {
      for (const spec of [gateway, kernel]) {
        const stopped = await bootoutLaunchAgent(spec.label, {
          domain,
          unloadTimeoutMs: 15_000,
        });
        expect(stopped.code).toBe(0);
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
