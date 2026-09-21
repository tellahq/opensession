import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGeneratedTitleRegistry } from "./generated-title-registry";

async function fixture(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "title-registry-"));
  try {
    await run(join(dir, "titles.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("independent writers merge fresh snapshots after acquiring the process lock", async () => {
  await fixture(async (path) => {
    await writeFile(path, JSON.stringify({ existing: "Original title" }));
    const lock = `${path}.lock`;
    const command =
      process.platform === "darwin"
        ? ["/usr/bin/lockf", "-k", "-t", "10", lock]
        : ["flock", "-w", "10", lock];
    const holder = Bun.spawn(
      [
        ...command,
        process.execPath,
        "-e",
        'console.log("locked"); await Bun.stdin.text()',
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = holder.stdout.getReader();
    try {
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("locked");
      const writers = Array.from({ length: 24 }, (_, i) =>
        writeGeneratedTitleRegistry(path, `session-${i}`, `Title ${i}`),
      );
      // While all writers are excluded, change the registry. Each child must
      // read this value inside its lock, not capture a snapshot before waiting.
      await writeFile(
        path,
        JSON.stringify({
          existing: "Refreshed title",
          sibling: "Sibling title",
        }),
      );
      holder.stdin.end();
      expect(await holder.exited).toBe(0);
      await Promise.all(writers);
      const result = JSON.parse(await readFile(path, "utf8"));
      expect(result.existing).toBe("Refreshed title");
      expect(result.sibling).toBe("Sibling title");
      for (let i = 0; i < 24; i++)
        expect(result[`session-${i}`]).toBe(`Title ${i}`);
      expect(Object.keys(result)).toHaveLength(26);
      // The stable lock file remains, but has no owner after the children exit.
      await writeGeneratedTitleRegistry(path, "existing", "Latest title");
      expect(JSON.parse(await readFile(path, "utf8")).existing).toBe(
        "Latest title",
      );
    } finally {
      reader.releaseLock();
      holder.stdin.end();
      await holder.exited;
    }
  });
}, 20_000);

test("a malformed registry is not overwritten and a failed writer releases its lock", async () => {
  await fixture(async (path) => {
    await writeFile(path, "broken json");
    await expect(
      writeGeneratedTitleRegistry(path, "new", "New title"),
    ).rejects.toThrow("Title registry write failed");
    expect(await readFile(path, "utf8")).toBe("broken json");
    await writeFile(path, JSON.stringify({ existing: "Existing title" }));
    await writeGeneratedTitleRegistry(path, "new", "New title");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      existing: "Existing title",
      new: "New title",
    });
  });
});
