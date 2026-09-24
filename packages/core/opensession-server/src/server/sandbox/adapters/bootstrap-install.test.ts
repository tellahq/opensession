import { describe, expect, test } from "bun:test";
import {
  baseRuntimeSignature,
  bootstrapRemoteSandbox,
  type RemoteDriver,
} from "./bootstrap";

/** A driver answering each command with `answer(command)`; records them. */
function fakeDriver(
  commands: string[],
  answer: (command: string) => { exitCode: number; stdout?: string } = () => ({
    exitCode: 0,
  }),
  written: string[] = [],
): RemoteDriver {
  return {
    async exec(command) {
      commands.push(command);
      const { exitCode, stdout = "" } = answer(command);
      return { exitCode, stdout, stderr: "" };
    },
    async execBackground() {},
    async writeFile(path) {
      written.push(path);
    },
    async ensureStarted() {},
  };
}

const prepared = (command: string) =>
  command.startsWith("cat ") && command.includes(".opensession-base-runtime")
    ? { exitCode: 0, stdout: baseRuntimeSignature() }
    : { exitCode: 0 };

describe("remote base runtime", () => {
  test("a prepared Sandbox costs two commands and repairs the identity command", async () => {
    const commands: string[] = [];
    await bootstrapRemoteSandbox(fakeDriver(commands, prepared), "test");
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain(".opensession-base-runtime");
    expect(commands[1]).toContain(
      "/home/ubuntu/.local/share/opensession/workload-identity-client.ts",
    );
    expect(commands[1]).toContain(
      "test -x /home/ubuntu/.local/bin/opensession",
    );
  });

  test("a damaged identity command is uploaded again", async () => {
    const commands: string[] = [];
    const written: string[] = [];
    let repairs = 0;
    await bootstrapRemoteSandbox(
      fakeDriver(
        commands,
        (command) =>
          command.includes("test -x /home/ubuntu/.local/bin/opensession") &&
          repairs++ === 0
            ? { exitCode: 1 }
            : prepared(command),
        written,
      ),
      "test",
    );
    expect(written).toEqual([
      "/home/ubuntu/.local/share/opensession/workload-identity-client.ts",
    ]);
  });

  test("installs nothing of Open Session itself", async () => {
    const commands: string[] = [];
    await bootstrapRemoteSandbox(
      fakeDriver(commands, (command) =>
        command.startsWith("cat ") ? { exitCode: 1 } : { exitCode: 0 },
      ),
      "test",
    );
    const all = commands.join("\n");
    expect(all).toContain(".opensession-base-runtime");
    for (const absent of [
      "projects/opensession",
      "opensession-runner",
      "claude-code",
      "bun install --frozen-lockfile",
      ".bks-bootstrapped",
    ])
      expect(all).not.toContain(absent);
  });

  test("the signature names no Open Session commit", () => {
    expect(baseRuntimeSignature()).toStartWith("base+node@");
    expect(baseRuntimeSignature()).not.toMatch(/[0-9a-f]{40}/);
  });

  test("reports a failed step with its exit code even without output", async () => {
    await expect(
      bootstrapRemoteSandbox(
        fakeDriver([], (command) =>
          command.startsWith("cat ") ? { exitCode: 1 } : { exitCode: 137 },
        ),
        "test",
      ),
    ).rejects.toThrow("exit 137): no command output");
  });
});
