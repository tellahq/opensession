import { findSessionAsync } from "../session-cache";
import { sessionContextSnapshot } from "../session-context";
import { mergedSessionTranscriptAsync } from "../sessions";
import type { RouteContext } from "./context";

/** The silently injected provider input, separate from the conversation so
 * its large body can be fetched only when the collapsed row is opened. */
export async function handleSessionContextRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;
  const match = path.match(/^\/api\/sessions\/([^/]+)\/session-context$/);
  if (!match || req.method !== "GET") return undefined;
  const sessionId = decodeURIComponent(match[1]);
  const session = await findSessionAsync(sessionId);
  if (!session)
    return Response.json({ error: "Session not found" }, { status: 404 });
  const context = sessionContextSnapshot(
    await mergedSessionTranscriptAsync(session),
  );
  if (!context) return Response.json({ available: false });
  const includeContent = url.searchParams.get("content") === "1";
  return Response.json({
    available: true,
    exact: context.exact,
    bytes: context.bytes,
    estimatedTokens: context.estimatedTokens,
    ...(includeContent ? { content: context.content } : {}),
  });
}
