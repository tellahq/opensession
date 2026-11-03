import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichAsync } from "./which-async";

describe("whichAsync", () => {
  test("finds the first executable on PATH and skips non-executables", async () => {
    const a = await mkdtemp(join(tmpdir(), "which-a-"));
    const b = await mkdtemp(join(tmpdir(), "which-b-"));
    await writeFile(join(a, "acme-tool"), "#!/bin/sh\n");
    await writeFile(join(b, "acme-tool"), "#!/bin/sh\n");
    await chmod(join(b, "acme-tool"), 0o755);
    expect(await whichAsync("acme-tool", `${a}:${b}`)).toBe(
      join(b, "acme-tool"),
    );
    expect(await whichAsync("acme-missing", `${a}:${b}`)).toBeNull();
  });

  test("matches Bun.which for a common command", async () => {
    expect(await whichAsync("sh")).toBe(Bun.which("sh"));
  });
});
