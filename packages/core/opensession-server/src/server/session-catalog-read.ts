/** Cross-session metadata reads use the central catalog, never actor/file fanout. */
import { sessionMetadata } from "./session-kernel";
import { isNativeSessionId } from "./paths";
import type { NativeSessionFile } from "./types";

export async function* catalogSessionDocuments(
  afterSessionId = "",
): AsyncGenerator<{
  sessionId: string;
  data: NativeSessionFile;
}> {
  if (!(await sessionMetadata({ op: "catalog_complete" })))
    throw new Error(
      "Session metadata catalog is not seeded; run scripts/seed-session-metadata-catalog.ts",
    );
  for (;;) {
    const page = await sessionMetadata({
      op: "catalog_page",
      afterSessionId,
      limit: 200,
    });
    if (!page.length) return;
    for (const row of page) {
      const data = JSON.parse(row.doc);
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        (data.id != null && data.id !== row.sessionId)
      )
        throw new Error(`Invalid session catalog document: ${row.sessionId}`);
      yield { sessionId: row.sessionId, data };
    }
    const next = page[page.length - 1]!.sessionId;
    if (next <= afterSessionId)
      throw new Error("Session catalog cursor made no progress");
    afterSessionId = next;
    await Bun.sleep(0);
  }
}

export async function catalogNativeSessions(): Promise<NativeSessionFile[]> {
  const sessions: NativeSessionFile[] = [];
  for await (const { sessionId, data } of catalogSessionDocuments())
    if (isNativeSessionId(sessionId)) sessions.push({ ...data, id: sessionId });
  return sessions;
}
