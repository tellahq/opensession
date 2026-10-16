import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type RunAgentOpts } from "./agent-runner";
import { runPi } from "./pi-runner";
import { assertPersonalAttachmentsAbsent } from "./personal-image-admission";
import { assertPersonalHostMcpNone } from "./personal-repo-runtime-mcp";

const payloads: unknown[] = [
  null,
  {},
  "malformed",
  [null],
  [{ path: "/unavailable/shared-upload" }],
  [{ mediaType: "image/png", data: "aGVsbG8=" }],
];
for (const field of ["images", "files", "attachments"] as const) {
  test(`private ${field} fail closed before engine staging, shared payloads unchanged`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "private-media-denied-"));
    try {
      for (const payload of payloads) {
        const opts = {
          personalRepo: {},
          mcpServers: [],
          proxyMcpServers: [],
          cwd: dir,
          scratchDir: dir,
          prompt: "test",
          [field]: payload,
        };
        expect(() => assertPersonalAttachmentsAbsent(opts)).toThrow(
          "attachments are unavailable",
        );
        expect(() => assertPersonalHostMcpNone(opts)).toThrow(
          "attachments are unavailable",
        );
        expect(() =>
          assertPersonalAttachmentsAbsent({ ...opts, personalRepo: undefined }),
        ).not.toThrow();
        await expect(
          runAgent(opts as unknown as RunAgentOpts).next(),
        ).rejects.toThrow("attachments are unavailable");
        await expect(
          runPi(opts as unknown as RunAgentOpts, "invalid-model").next(),
        ).rejects.toThrow("attachments are unavailable");
        expect(await readdir(dir)).toEqual([]);
      }
      for (const payload of [undefined, []]) {
        expect(() =>
          assertPersonalAttachmentsAbsent({
            personalRepo: {},
            [field]: payload,
          }),
        ).not.toThrow();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
