import { z } from "zod";
import { findSessionAsync } from "../session-cache";
import { mergedSessionTranscriptAsync } from "../sessions";
import {
  SESSION_VOICE_HELPER_TARGETS,
  sessionVoiceContext,
} from "../../shared/session-voice";
import { createSessionVoiceAnswer } from "../session-voice";
import { askSessionVoiceTarget } from "../session-voice-helper";
import type { RouteContext } from "./context";

const offerSchema = z.object({
  sdp: z
    .string()
    .min(1)
    .max(64 * 1024)
    // SDP is a wire format: trimming removes its required final CRLF.
    .refine((sdp) => sdp.trim().length > 0),
});
// Exactly the tool-less reasoning tiers. `session_agent` is not a helper:
// user-requested agent work only travels the durable outbox path.
const helperSchema = z.object({
  model: z.enum(SESSION_VOICE_HELPER_TARGETS),
  prompt: z.string().trim().min(1).max(4000),
});
const activeHelpers = new Set<string>();

export async function handleSessionVoiceRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const match = ctx.path.match(/^\/api\/sessions\/([^/]+)\/voice(\/helper)?$/);
  if (!match || ctx.req.method !== "POST") return undefined;
  // Paid voice/helper calls require a human web identity, never a claimed
  // name or machine credential. Helpers reason over the bounded transcript
  // only; this route cannot run tools, write a transcript, or queue agent
  // work. The client sends user-requested tasks through the normal outbox.
  if (!ctx.authUser?.login)
    return Response.json(
      { error: "Sign in to start a voice call." },
      { status: 401 },
    );
  if (process.env.OPENSESSION_DEMO === "1")
    return Response.json(
      { error: "Voice calls are unavailable in the demo." },
      { status: 503 },
    );
  const helper = !!match[2];
  const body = await ctx.req.json().catch(() => null);
  const offer = offerSchema.safeParse(body);
  const question = helperSchema.safeParse(body);
  if (helper ? !question.success : !offer.success)
    return Response.json(
      {
        error: helper
          ? "Invalid voice helper request."
          : "Invalid voice offer.",
      },
      { status: 400 },
    );
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
  } catch {
    return Response.json({ error: "Invalid session." }, { status: 400 });
  }
  const session = await findSessionAsync(sessionId);
  if (!session)
    return Response.json({ error: "Session not found." }, { status: 404 });
  if (
    (session.source !== "opensession" && session.source !== "slack") ||
    session.archived
  )
    return Response.json(
      { error: "Open an active Open Session conversation to call its agent." },
      { status: 409 },
    );
  const helperKey = JSON.stringify([ctx.authUser.login, session.id]);
  if (helper && (activeHelpers.has(helperKey) || activeHelpers.size >= 8))
    return Response.json(
      { error: "A voice helper is already working. Try again shortly." },
      { status: 429 },
    );
  if (helper) activeHelpers.add(helperKey);
  try {
    const context = sessionVoiceContext(
      await mergedSessionTranscriptAsync(session),
    );
    if (helper && question.success) {
      const answer = await askSessionVoiceTarget(
        question.data.model,
        session,
        question.data.prompt,
        context,
        ctx.req.signal,
        ctx.authUser.login,
      );
      return Response.json(
        {
          text: answer.text,
          model: question.data.model,
          engineModel: answer.model,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!offer.success)
      return Response.json({ error: "Invalid voice offer." }, { status: 400 });
    const sdp = await createSessionVoiceAnswer(
      offer.data.sdp,
      ctx.req.signal,
      context,
    );
    return Response.json({ sdp }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not complete the voice request.",
      },
      { status: 502 },
    );
  } finally {
    if (helper) activeHelpers.delete(helperKey);
  }
}
