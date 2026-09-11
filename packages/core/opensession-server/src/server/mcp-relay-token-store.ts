import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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

/** One immutable record per server/identity order. Atomic publication avoids
 * both stale process caches and lost updates from concurrent run hosts. */
export function createMcpRelayTokenStore(legacyPath: string) {
  const directory = `${legacyPath}.d`;
  return {
    async mint(server: string, grantUsers: string[]): Promise<string> {
      const key = createHash("sha256")
        .update(JSON.stringify([server, grantUsers]))
        .digest("hex");
      const path = join(directory, `${key}.json`);
      const existing = await readJson(path);
      if (existing !== undefined) return recordSchema.parse(existing).token;

      await mkdir(directory, { recursive: true, mode: 0o700 });
      const token = `v2.${key}.${randomBytes(24).toString("base64url")}`;
      const temporary = join(directory, `${token}.tmp`);
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            server,
            grantUsers,
            createdAt: new Date().toISOString(),
            token,
          }),
          { mode: 0o600, flag: "wx" },
        );
        try {
          // Unlike rename, link never replaces another process's winning token.
          await link(temporary, path);
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw error;
        }
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw error;
        });
      }
      return recordSchema.parse(await readJson(path)).token;
    },
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
      // Detached hosts pinned to an older release still mint the legacy format.
      // Read it fresh, never from a process-local cache, and never rewrite it.
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
