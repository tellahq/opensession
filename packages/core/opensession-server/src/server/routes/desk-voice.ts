/**
 * Desk voice mode routes — the HTTP surface behind the overlay's mic toggle
 * (src/server/desk-voice.ts has the model). The browser holds the WebRTC leg
 * to OpenAI; these routes are the authenticated relay: secret minting (the
 * real API key never reaches the client), tool execution as the verified
 * user, and transcript mirroring into the standing Desk session.
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
  executeVoiceTool,
  mintVoiceSecret,
  mirrorVoiceEntries,
  mirrorVoiceToolCall,
  recordVoiceDiag,
  setVoiceKey,
  voiceKeyConfigured,
  voiceKeyMasked,
} from "../desk-voice";

function keyStatus(): Response {
  return Response.json({
    configured: voiceKeyConfigured(),
    keyMasked: voiceKeyMasked(),
  });
}

export async function handleDeskVoiceRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (!path.startsWith("/api/desk/voice/")) return undefined;

  if (path === "/api/desk/voice/status" && req.method === "GET")
    return keyStatus();

  if (path === "/api/desk/voice/key" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.apiKey !== "string")
      return Response.json(
        { error: "expected { apiKey: string }" },
        { status: 400 },
      );
    setVoiceKey(body.apiKey);
    return keyStatus();
  }

  if (path === "/api/desk/voice/secret" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    try {
      return Response.json(await mintVoiceSecret(user));
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 502 });
    }
  }

  if (path === "/api/desk/voice/tool" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.name !== "string" ||
      typeof body.callId !== "string"
    )
      return Response.json(
        { error: "expected { callId, name, args }" },
        { status: 400 },
      );
    const user = requestUser(ctx, body.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    const args =
      body.args && typeof body.args === "object"
        ? (body.args as Record<string, unknown>)
        : {};
    try {
      const result = await executeVoiceTool(user, body.name, args);
      mirrorVoiceToolCall(user, body.callId, body.name, args, result);
      return Response.json({ result });
    } catch (e: any) {
      const message = e?.message || String(e);
      mirrorVoiceToolCall(user, body.callId, body.name, args, {
        error: message,
      });
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (path === "/api/desk/voice/transcript" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.entries))
      return Response.json(
        { error: "expected { entries: [{id, role, text}] }" },
        { status: 400 },
      );
    const user = requestUser(ctx, body.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    const entries = (body.entries as unknown[])
      .filter(
        (e): e is { id: string; role: "user" | "assistant"; text: string } => {
          const x = e as Record<string, unknown>;
          return (
            !!x &&
            typeof x.id === "string" &&
            (x.role === "user" || x.role === "assistant") &&
            typeof x.text === "string" &&
            !!(x.text as string).trim()
          );
        },
      )
      .slice(0, 20);
    mirrorVoiceEntries(user, entries);
    return Response.json({ ok: true });
  }

  if (path === "/api/desk/voice/diag" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object")
      return Response.json({ error: "expected an object" }, { status: 400 });
    const user = requestUser(ctx, (body as { user?: string }).user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    recordVoiceDiag(user, body as Record<string, unknown>);
    return Response.json({ ok: true });
  }

  return undefined;
}
