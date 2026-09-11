import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const grantSchema = z.object({
  server: z.string(),
  grantUsers: z.array(z.string()),
  createdAt: z.string(),
});
const recordSchema = grantSchema.extend({ token: z.string() });

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

/** Ship both readers before switching writers: a gateway rollback must still
 * understand tokens held by detached hosts from the newer release. */
export function createMcpRelayTokenReader(legacyPath: string) {
  const directory = `${legacyPath}.d`;
  return {
    async lookup(
      token: string,
    ): Promise<z.infer<typeof grantSchema> | undefined> {
      const match = /^v2\.([a-f0-9]{64})\.[A-Za-z0-9_-]{32}$/.exec(token);
      if (match) {
        const parsed = recordSchema.safeParse(
          await readJson(join(directory, `${match[1]}.json`)),
        );
        if (!parsed.success) return undefined;
        const expected = Buffer.from(parsed.data.token);
        const actual = Buffer.from(token);
        return expected.length === actual.length &&
          timingSafeEqual(expected, actual)
          ? parsed.data
          : undefined;
      }
      // Read fresh on every request, including after a different host mints a
      // token. The writer's process-local snapshot is never a relay authority.
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return undefined;
      const legacy = z
        .record(z.string(), z.unknown())
        .safeParse(await readJson(legacyPath));
      if (!legacy.success) return undefined;
      const grant = grantSchema.safeParse(legacy.data[token]);
      return grant.success ? grant.data : undefined;
    },
  };
}
