/** Live seeding tests: the real reseedEnv / copySeedEnvFiles against real
 *  containers, because the shape of a file copy proves nothing about whether a
 *  booting container actually reads what we wrote.
 *
 *  Opt in — these build a small image and create/destroy containers:
 *    SEED_TEST_LIVE=1 bun test src/server/preview-pool-seed.integration.test.ts
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { copySeedEnvFiles, reseedEnv, SEED_ENV_FILES } from "./preview-pool";
import { configuredRepos } from "./config";

const describeLive =
  process.env.SEED_TEST_LIVE === "1" ? describe : describe.skip;

/** Matches preview-pool's in-container workspace. */
const WORKSPACE = "/home/ubuntu/preview-workspace";
const ENV_REL = SEED_ENV_FILES[0];
const IMAGE = "os-seedtest-golden:latest";

const repo = () => {
  const r = configuredRepos()["tella-fusion"];
  if (!r) throw new Error("tella-fusion is not a configured repo on this host");
  return r;
};

const sh = async (cmd: string[]): Promise<string> =>
  (await $`${cmd}`.quiet().nothrow().text()).trim();

/** A stand-in golden: the workspace tree exists (so `docker cp` has a parent to
 *  land in, as it does in a real golden) and the boot command reads the env
 *  file the way .agents/start.sh does. */
async function ensureImage(): Promise<void> {
  const df = `FROM backstage-runner:latest\nRUN mkdir -p ${WORKSPACE}/$(dirname ${ENV_REL})\n`;
  await Bun.write("/tmp/os-seedtest.Dockerfile", df);
  await sh([
    "docker",
    "build",
    "-q",
    "-t",
    IMAGE,
    "-f",
    "/tmp/os-seedtest.Dockerfile",
    "/tmp",
  ]);
}

const BOOT_READS_ENV = `grep -m1 '^FLAGS=' ${WORKSPACE}/${ENV_REL} || echo NO-ENV-AT-BOOT`;

async function createContainer(name: string): Promise<void> {
  await sh([
    "docker",
    "create",
    "--name",
    name,
    "-w",
    WORKSPACE,
    IMAGE,
    "bash",
    "-c",
    BOOT_READS_ENV,
  ]);
}

async function startAndReadBootLog(name: string): Promise<string> {
  await sh(["docker", "start", name]);
  await sh(["docker", "wait", name]);
  return sh(["docker", "logs", name]);
}

describeLive("preview-pool seeding (live containers)", () => {
  test("a golden without seeding boots with no env — the bug this fixes", async () => {
    const name = `os-seedtest-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await ensureImage();
      await createContainer(name);
      expect(await startAndReadBootLog(name)).toContain("NO-ENV-AT-BOOT");
    } finally {
      await sh(["docker", "rm", "-f", name]);
    }
  }, 300_000);

  test("copySeedEnvFiles lands before the boot command reads it", async () => {
    const name = `os-seedtest-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await ensureImage();
      await createContainer(name);
      await copySeedEnvFiles(name, repo());
      const log = await startAndReadBootLog(name);
      expect(log).toContain("FLAGS=");
      expect(log).not.toContain("NO-ENV-AT-BOOT");
    } finally {
      await sh(["docker", "rm", "-f", name]);
    }
  }, 300_000);

  test("reseedEnv replaces a rotated key in a running member", async () => {
    const name = `os-seedtest-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await ensureImage();
      await sh([
        "docker",
        "run",
        "-d",
        "--name",
        name,
        "-w",
        WORKSPACE,
        IMAGE,
        "sleep",
        "300",
      ]);
      await sh([
        "docker",
        "exec",
        name,
        "bash",
        "-c",
        `printf 'FLAGS="stale-rotated-key"\\n' > ${WORKSPACE}/${ENV_REL}`,
      ]);
      expect(
        await sh(["docker", "exec", name, "cat", `${WORKSPACE}/${ENV_REL}`]),
      ).toContain("stale-rotated-key");

      await reseedEnv({
        name,
        repoId: "tella-fusion",
        state: "ready",
        hostPort: 0,
        bootSha: "",
        createdAt: new Date().toISOString(),
      });

      const after = await sh([
        "docker",
        "exec",
        name,
        "grep",
        "-m1",
        "^FLAGS=",
        `${WORKSPACE}/${ENV_REL}`,
      ]);
      expect(after).toContain("FLAGS=");
      expect(after).not.toContain("stale-rotated-key");
      // tella-fusion's pool config sets devAuthBypass, so the strip rule must
      // follow config rather than always firing.
      const devAuth = await sh([
        "docker",
        "exec",
        name,
        "bash",
        "-c",
        `grep -c '^DEV_AUTH_USER_ID' ${WORKSPACE}/${ENV_REL} || true`,
      ]);
      expect(devAuth).toBe("1");
    } finally {
      await sh(["docker", "rm", "-f", name]);
    }
  }, 300_000);
});
