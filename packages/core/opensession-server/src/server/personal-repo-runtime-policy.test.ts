import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonalPolicyClient } from "./personal-repo-runtime-policy";

test("worker owns roster/persona reads and preserves exact human/machine policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "personal-policy-worker-"));
  const config = join(root, "config.json");
  await writeFile(config, "{}");
  let client = createPersonalPolicyClient({
    HOME: root,
    OPENSESSION_STATE_DIR: root,
    OPENSESSION_CONFIG: config,
    PATH: "/usr/bin:/bin",
  });
  try {
    expect(
      await client.classify({
        mode: "ask",
        user: "Alice",
        journalKind: "prompt",
      }),
    ).toBe("installation-read");
    expect(
      await client.classify({
        mode: "code",
        user: "Alice",
        journalKind: "prompt",
      }),
    ).toBe("installation-write");
    expect(await client.classify({ mode: "code", user: "Alice" })).toBe(
      "installation-write",
    );
    expect(
      await client.classify({
        mode: "code",
        user: "GitHub",
        journalKind: "prompt",
      }),
    ).toBe("installation-write");
    await writeFile(
      config,
      JSON.stringify({
        identity: {
          team: [
            {
              name: "GitHub",
              email: "fixture@example.invalid",
              github: "fixture-human",
            },
          ],
        },
      }),
    );
    // Existing roster tables are a boot snapshot. A fresh worker/host sees
    // changed configuration; neither thread silently mutates the other's map.
    client.close();
    client = createPersonalPolicyClient({
      HOME: root,
      OPENSESSION_STATE_DIR: root,
      OPENSESSION_CONFIG: config,
      PATH: "/usr/bin:/bin",
    });
    expect(
      await client.classify({
        mode: "code",
        user: "GitHub",
        journalKind: "prompt",
      }),
    ).toBe("installation-write");
    expect(
      await client.classify({
        mode: "code",
        user: "GitHub",
        journalKind: "automation",
      }),
    ).toBe("installation-write");
    client.close();
    await expect(
      client.classify({ mode: "code", user: "Alice" }),
    ).rejects.toThrow("unavailable");
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale policy worker cannot return legacy user authority", async () => {
  const OriginalWorker = globalThis.Worker;
  try {
    for (const kind of ["user", "unknown", null, undefined]) {
      globalThis.Worker = class {
        onmessage?: (event: { data: unknown }) => void;
        addEventListener() {}
        terminate() {}
        postMessage(input: { id: string }) {
          queueMicrotask(() =>
            this.onmessage?.({ data: { id: input.id, kind } }),
          );
        }
      } as unknown as typeof Worker;
      const client = createPersonalPolicyClient();
      try {
        await expect(
          client.classify({
            mode: "code",
            user: "Alice",
            journalKind: "prompt",
          }),
        ).rejects.toThrow("classification unavailable");
      } finally {
        client.close();
      }
    }
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});
