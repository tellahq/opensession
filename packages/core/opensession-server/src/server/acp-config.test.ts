import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAcpAgents, acpUnavailableReason } from "./acp-config";

test("ACP instance configuration validates ids, arguments and environments", () => {
  const config = {
    id: "example",
    name: "Example",
    command: "example-agent",
    args: ["--acp"],
    env: { PROFILE: "coding" },
  };
  expect(parseAcpAgents([config])).toEqual([config]);
  for (const invalid of [
    [config, config],
    [{ ...config, id: "bad/id" }],
    [{ ...config, command: "" }],
    [{ ...config, args: [1] }],
    [{ ...config, env: { TOKEN: 1 } }],
  ])
    expect(() => parseAcpAgents(invalid)).toThrow();
  expect(parseAcpAgents(undefined)).toEqual([]);
});

test("availability uses the instance PATH and reports missing executables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-bin-"));
  try {
    await writeFile(join(dir, "example-agent"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    expect(
      await acpUnavailableReason({
        id: "example",
        name: "Example",
        command: "example-agent",
        env: { PATH: dir },
      }),
    ).toBeUndefined();
    expect(
      await acpUnavailableReason({
        id: "missing",
        name: "Missing",
        command: "missing-agent",
        env: { PATH: dir },
      }),
    ).toContain("unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
