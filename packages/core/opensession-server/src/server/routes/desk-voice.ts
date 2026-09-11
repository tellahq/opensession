/**
 * Desk voice mode routes — the HTTP surface behind the overlay's mic toggle.
 *
 * Web (GPT-Live, src/server/desk-voice-live.ts): `/live` exchanges the
 * browser's WebRTC offer for an answer while the server creates the session
 * and attaches its sideband; `/live/text` and `/live/close` steer that call.
 * Tool calls and transcripts never pass through the browser.
 *
 * Native iOS (GPT Realtime, src/server/desk-voice.ts): the device holds the
 * connection to OpenAI, so `/secret`, `/tool`, `/transcript` and `/diag` are
 * its authenticated relay: secret minting (the real API key never reaches the
 * client), tool execution as the verified user, transcript mirroring.
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
  DESK_LIVE_BACKEND_MODELS,
  executeVoiceTool,
  mintVoiceSecret,
  mirrorVoiceEntries,
  mirrorVoiceToolCall,
  recordVoiceDiag,
  isLiveBackendModel,
  setVoiceBackendModel,
  setVoiceKey,
  voiceBackendModel,
  voiceKeyConfigured,
  voiceKeyMasked,
} from "../desk-voice";
import {
  closeLiveVoiceCall,
  createLiveVoiceCall,
  sendLiveVoiceText,
} from "../desk-voice-live";

/** An SDP offer is a few KB; anything bigger is not a browser offer. */
const MAX_SDP_BYTES = 64 * 1024;

/** The instance-wide voice settings: key state and the web call's backend. */
async function voiceStatus(): Promise<Response> {
  return Response.json({
    configured: await voiceKeyConfigured(),
    keyMasked: await voiceKeyMasked(),
    backendModel: await voiceBackendModel(),
    backendModels: DESK_LIVE_BACKEND_MODELS,
  });
}

export async function handleDeskVoiceRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (!path.startsWith("/api/desk/voice/")) return undefined;

  if (path === "/api/desk/voice/status" && req.method === "GET")
    return voiceStatus();

  if (path === "/api/desk/voice/key" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.apiKey !== "string")
      return Response.json(
        { error: "expected { apiKey: string }" },
        { status: 400 },
      );
    await setVoiceKey(body.apiKey);
    return voiceStatus();
  }

  // Fails closed: only the two allowed ids are stored, anything else is a
  // 400 and the setting is left as it was.
  if (path === "/api/desk/voice/backend" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const model: unknown = body?.model;
    if (typeof model !== "string")
      return Response.json(
        { error: "expected { model: string }" },
        { status: 400 },
      );
    if (!isLiveBackendModel(model))
      return Response.json(
        { error: "Voice backend must be gpt-5.6-terra or gpt-5.6-luna" },
        { status: 400 },
      );
    await setVoiceBackendModel(model);
    return voiceStatus();
  }

  if (path === "/api/desk/voice/live" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.sdp !== "string" ||
      !body.sdp.trim() ||
      body.sdp.length > MAX_SDP_BYTES
    )
      return Response.json(
        { error: "expected { sdp: string }" },
        { status: 400 },
      );
    const user = requestUser(ctx, body.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    try {
      return Response.json(await createLiveVoiceCall(user, body.sdp), {
        status: 201,
      });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 502 });
    }
  }

  if (path === "/api/desk/voice/live/text" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.liveSessionId !== "string" ||
      typeof body.text !== "string"
    )
      return Response.json(
        { error: "expected { liveSessionId, text }" },
        { status: 400 },
      );
    const user = requestUser(ctx, body.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    if (!sendLiveVoiceText(user, body.liveSessionId, body.text))
      return Response.json({ error: "no live call" }, { status: 404 });
    return Response.json({ ok: true });
  }

  if (path === "/api/desk/voice/live/close" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.liveSessionId !== "string")
      return Response.json(
        { error: "expected { liveSessionId }" },
        { status: 400 },
      );
    const user = requestUser(ctx, body.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    return Response.json({
      ok: closeLiveVoiceCall(user, body.liveSessionId),
    });
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
    await recordVoiceDiag(user, body as Record<string, unknown>);
    return Response.json({ ok: true });
  }

  return undefined;
}
