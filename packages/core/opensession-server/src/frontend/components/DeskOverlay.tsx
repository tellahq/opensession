import React, { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { BASE_PATH } from "../lib/base";
import { getCurrentUser } from "./UserPicker";
import { DeskConversation } from "./DeskConversation";
import { DESK_SUGGESTIONS } from "../lib/desk-suggestions";
import { Modal } from "../ui/modal";
import { IconDesk, IconExpand, IconMinus } from "./icons";
import { Button } from "../ui/button";
import { DeskVoiceClient, type DeskVoiceState } from "../lib/desk-voice-client";
import { getDeskVoicePref, onDeskVoiceChanged } from "../lib/desk-voice-pref";
import { cn } from "../ui/cn";
import { errorMessage } from "../lib/error-message";

/**
 * The Desk — a summonable overlay (⌘J / the floating desk button) on top of
 * whatever you're doing. It is a standing concierge session for quick asks
 * and kicking off work without leaving the current view.
 *
 * Persistence is the point: after the first summon the body STAYS MOUNTED
 * (hidden, not unmounted) — the session's scoped socket keeps watching, so every
 * later ⌘J is instant with the transcript already in place. It uses the same
 * palette modal as the command menu.
 *
 * The Desk is a normal durable session (desk: true, hidden from the session
 * lists) pinned to a fast model+effort server-side; "Clear" sets a display
 * marker (server-stored) so the modal starts visually fresh while the full
 * transcript stays in the expanded session view.
 */

interface DeskOverlayProps {
  open: boolean;
  openOrigin: "center" | "bottom-right";
  onClose: () => void;
  phone: boolean;
  /** Open the Desk session in the full viewer. */
  onOpenSession: (sessionId: string) => void;
}

function DeskBody({
  active,
  phone,
  onClose,
  onOpenSession,
}: Omit<DeskOverlayProps, "open" | "openOrigin"> & { active: boolean }) {
  const user = getCurrentUser();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [clearedAt, setClearedAt] = useState<string | undefined>(undefined);
  const [ensureError, setEnsureError] = useState<string | null>(null);
  // The Desk session's stored model + effort, so the composer's pill opens on
  // what this session actually runs rather than on the instance default.
  const [settings, setSettings] = useState<{ model?: string; effort?: string }>(
    {},
  );

  // Voice mode (Settings → Desk voice): a live GPT Realtime call layered on
  // this same Desk session. The call mirrors its transcript into the session,
  // so the conversation below updates live while you talk.
  const [voiceEnabled, setVoiceEnabled] = useState(getDeskVoicePref);
  const [voiceState, setVoiceState] = useState<DeskVoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceRef = useRef<DeskVoiceClient | null>(null);
  useEffect(
    () => onDeskVoiceChanged(() => setVoiceEnabled(getDeskVoicePref())),
    [],
  );
  // Never leave a mic running past the overlay body's lifetime.
  useEffect(
    () => () => {
      voiceRef.current?.stop();
    },
    [],
  );

  const voiceActive = voiceState !== "idle" && voiceState !== "error";

  function toggleVoice() {
    if (voiceRef.current?.active) {
      voiceRef.current.stop();
      return;
    }
    setVoiceError(null);
    const client = new DeskVoiceClient({
      user,
      onState: (s, detail) => {
        setVoiceState(s);
        if (s === "error") setVoiceError(detail || "Voice call failed");
      },
    });
    voiceRef.current = client;
    void client.start().catch((error) => {
      setVoiceState("error");
      setVoiceError(errorMessage(error, "Voice call failed"));
    });
  }

  // One-time boot (the body stays mounted after the first summon): resolve
  // the standing Desk session + the clear marker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await (async () => {
        const res = await fetch(`${BASE_PATH}/api/desk/ensure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = z
          .object({
            sessionId: z.string(),
            clearedAt: z.string().nullable(),
            session: z
              .object({
                model: z.string().optional(),
                effort: z.string().optional(),
              })
              .nullable(),
          })
          .parse(await res.json());
        if (cancelled) return;
        setSessionId(data.sessionId);
        setSettings({
          model: data.session?.model,
          effort: data.session?.effort,
        });
        if (data.clearedAt) setClearedAt(data.clearedAt);
      })().catch(async (error) => {
        if (!cancelled)
          setEnsureError(errorMessage(error, "Failed to open the Desk"));
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function clearSession() {
    await (async () => {
      const res = await fetch(`${BASE_PATH}/api/desk/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user }),
      });
      const data = z
        .object({ clearedAt: z.string().optional() })
        .parse(await res.json());
      if (data.clearedAt) setClearedAt(data.clearedAt);
    })().catch(async () => {});
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-divider px-4 py-2.5">
        <IconDesk size={22} className="text-dim" />
        <span className="min-w-0 flex-1 truncate text-item-title font-semibold text-fg">
          Desk
        </span>
        {voiceEnabled && voiceState !== "idle" && (
          <span
            className="max-w-[160px] shrink-0 truncate text-meta font-medium text-dim"
            title={voiceError ?? undefined}
          >
            {voiceState === "error"
              ? (voiceError ?? "Voice call failed")
              : {
                  connecting: "Connecting…",
                  listening: "Listening",
                  thinking: "Thinking…",
                  speaking: "Speaking",
                  action: "Working…",
                }[voiceState]}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-faint"
          onClick={clearSession}
          title="Clear the session here. The full transcript stays in the expanded session."
        >
          Clear chat
        </Button>
        {sessionId && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-faint"
            icon={<IconExpand size={20} />}
            onClick={() => {
              onClose();
              onOpenSession(sessionId);
            }}
            title="Open as a full session"
            aria-label="Open as a full session"
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-faint"
          icon={<IconMinus size={20} />}
          onClick={onClose}
          title="Minimise Desk"
          aria-label="Minimise Desk"
        />
      </div>

      {/* Concierge session */}
      <div className="min-h-0 flex-1">
        {ensureError ? (
          <div className="px-4 py-6 text-center text-label font-medium text-dim">
            {ensureError}
          </div>
        ) : sessionId ? (
          <DeskConversation
            sessionId={sessionId}
            presenceActive={active}
            autoFocus={active && !phone}
            model={settings.model}
            effort={settings.effort}
            hideBefore={clearedAt}
            voiceSend={(text) =>
              voiceRef.current?.active ? voiceRef.current.sendText(text) : false
            }
            // The Desk's job is delegating, so its transcript is full of
            // spawned workers. There's no side pane in a modal — open the
            // worker as a full session, the way the expand button does.
            onOpenSubagent={(id) => {
              onClose();
              onOpenSession(id);
            }}
            placeholder="Ask anything…"
            suggestions={DESK_SUGGESTIONS}
          />
        ) : (
          <div className="px-4 py-6 text-center text-label font-medium text-dim">
            Opening…
          </div>
        )}
      </div>
    </div>
  );
}

export function DeskOverlay({
  open,
  openOrigin,
  onClose,
  phone,
  onOpenSession,
}: DeskOverlayProps) {
  // Base UI's keepMounted preserves the Desk after its first summon, but it
  // also mounts hidden content on a cold app load. Gate the body until then so
  // a person who never opens Desk does not create its session, fetch its model
  // catalog, or hold a second WebSocket all day.
  const [opened, setOpened] = useState(open);
  useEffect(() => {
    if (open) setOpened(true);
  }, [open]);

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      modal="trap-focus"
    >
      <Modal.Content
        variant="palette"
        keepMounted
        widthClassName="w-[min(650px,100%)]"
        className={cn(
          phone ? "h-[min(600px,85dvh)]" : "h-[600px] max-h-[80dvh]",
          openOrigin === "center" ? "origin-center" : "origin-bottom-right",
          "rounded-b-[var(--composer-radius)] transition-[scale,translate,opacity]! duration-[100ms]! data-[starting-style]:translate-y-0! data-[starting-style]:scale-[0.9]!",
        )}
        aria-label="Desk"
      >
        {(open || opened) && (
          <DeskBody
            active={open}
            phone={phone}
            onClose={onClose}
            onOpenSession={onOpenSession}
          />
        )}
      </Modal.Content>
    </Modal.Root>
  );
}
