/**
 * The waiting-on-teammates board: list, nudge, cancel.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import { userMatchesAny } from "../shared/user-mappings";
import { sendSlackMessage } from "../../agents/slack/slack-api";
import { cancelAsk } from "../human-asks";
import { personaName } from "../config";

export async function handleHumanAsksRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // ── Human asks (waiting-on-teammates board) ──
  if (path === "/api/human-asks" && req.method === "GET") {
    const { listAsks } = await import("../../server/human-asks");
    return Response.json({
      asks: listAsks({
        includeAnswered: url.searchParams.get("all") === "1",
      }),
    });
  }

  // Answer an ask from the UI (the Desk board) rather than over Slack. Only
  // the teammate it was addressed to may answer: an ask is a named request,
  // and letting anyone resolve it would put words in their mouth and unblock
  // a run on someone else's authority.
  const askAnswerMatch = path.match(/^\/api\/human-asks\/([^/]+)\/answer$/);
  if (askAnswerMatch && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
    if (!answer)
      return Response.json(
        { error: "expected { answer: string }" },
        { status: 400 },
      );
    const user = requestUser(ctx, body?.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    const { getAsk, resolveAskFromUI } = await import("../human-asks");
    const ask = getAsk(askAnswerMatch[1]);
    if (!ask) return Response.json({ error: "Not found" }, { status: 404 });
    if (!userMatchesAny(user, [ask.person?.name].filter(Boolean) as string[]))
      return Response.json(
        { error: "This question was asked of someone else" },
        { status: 403 },
      );
    return resolveAskFromUI(ask.id, answer, user)
      ? Response.json({ ok: true })
      : Response.json(
          { error: "That question is no longer awaiting an answer" },
          { status: 409 },
        );
  }

  const askNudgeMatch = path.match(/^\/api\/human-asks\/([^/]+)\/nudge$/);
  if (askNudgeMatch && req.method === "POST") {
    const { getAsk } = await import("../../server/human-asks");
    const ask = getAsk(askNudgeMatch[1]);
    if (!ask) return Response.json({ error: "Not found" }, { status: 404 });
    if (ask.state !== "delivered" || !ask.slack)
      return Response.json(
        { error: "Ask isn't awaiting an answer on Slack" },
        { status: 400 },
      );
    const { sendSlackMessage } = await import("../../agents/slack/slack-api");
    await sendSlackMessage(
      ask.slack.channel,
      `It's ${personaName()} — friendly nudge, still waiting on this one 🙏`,
      ask.slack.rootTs,
    );
    return Response.json({ ok: true });
  }

  const askCancelMatch = path.match(/^\/api\/human-asks\/([^/]+)$/);
  if (askCancelMatch && req.method === "DELETE") {
    const { cancelAsk } = await import("../../server/human-asks");
    return cancelAsk(askCancelMatch[1])
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  return undefined;
}
