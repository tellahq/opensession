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
import { VoiceCaptionStore } from "../lib/voice-captions";
import { cn } from "../ui/cn";
import { errorMessage } from "../lib/error-message";
import { useDeskPanel } from "../hooks/useDeskPanel";
import { deskPanelOwnsFocus } from "../lib/desk-panel";
import {
  DESK_PANEL_GRAB,
  DESK_PANEL_HANDLE,
  DESK_PANEL_HANDLES,
  DESK_PANEL_ORIGIN,
} from "../lib/desk-panel-classes";

/**
 * The Desk — a summonable overlay (⌘J / the floating desk button) on top of
 * whatever you're doing. It is a standing concierge session for quick asks
 * and kicking off work without leaving the current view.
 *
 * Persistence is the point: after the first summon the body STAYS MOUNTED
 * (hidden, not unmounted) — the session's scoped socket keeps watching, so every
 * later ⌘J is instant with the transcript already in place.
 *
 * On desktop it is a floating panel, not a modal: no backdrop, no focus trap,
 * and the page underneath stays live, so it can sit open in a corner while
 * you work in other sessions. Its header drags it and its edges resize it
 * (hooks/useDeskPanel), and the place it was left is kept per browser. On a
 * phone it stays the sheet it was, over a backdrop, because there is no room
 * beside it for anything else.
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
  onGrab,
}: Omit<DeskOverlayProps, "open" | "openOrigin"> & {
  active: boolean;
  /** Desktop: a pointer down on the header starts moving the panel. */
  onGrab?: (event: React.PointerEvent<HTMLElement>) => void;
}) {
  const user = getCurrentUser();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [clearedAt, setClearedAt] = useState<string | undefined>(undefined);
  const [ensureError, setEnsureError] = useState<string | null>(null);
  // The Desk session's stored model + effort, so the composer's pill opens on
  // what this session actually runs rather than on the instance default.
  const [settings, setSettings] = useState<{ model?: string; effort?: string }>(
    {},
  );

  // Voice mode (Settings → Desk voice): a GPT-Live call layered on this same
  // Desk session. The server mirrors the call's transcript into the session
  // one settled utterance at a time; the call's own transcript deltas fill
  // the wait as live captions (one store for the body's lifetime, cleared as
  // each call starts), so the conversation below moves while you talk.
  const [voiceEnabled, setVoiceEnabled] = useState(getDeskVoicePref);
  const [voiceState, setVoiceState] = useState<DeskVoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceCaptions] = useState(() => new VoiceCaptionStore());
  const voiceRef = useRef<DeskVoiceClient | null>(null);
  useEffect(
    () => onDeskVoiceChanged(() => setVoiceEnabled(getDeskVoicePref())),
    [],
  );
  // Never leave a mic running past the overlay body's lifetime.
  useEffect(
    () => () => {
      voiceRef.current?.stop();
      voiceRef.current = null;
      voiceCaptions.clear();
    },
    [voiceCaptions],
  );

  const voiceActive = voiceState !== "idle" && voiceState !== "error";
  const voiceStatus: Record<DeskVoiceState, string | undefined> = {
    idle: undefined,
    error: undefined,
    connecting: "Connecting…",
    listening: "Listening",
    thinking: "Thinking…",
    speaking: "Speaking",
    action: "Working…",
  };

  function toggleVoice() {
    // `active` covers a start still connecting: pressing the handset again
    // then cancels that start instead of layering a second call on it.
    if (voiceRef.current?.active) {
      voiceRef.current.stop();
      return;
    }
    setVoiceError(null);
    voiceCaptions.clear();
    const client = new DeskVoiceClient({
      user,
      onState: (s, detail) => {
        if (voiceRef.current !== client) return;
        setVoiceState(s);
        if (s === "error") setVoiceError(detail || "Voice call failed");
        // The call is over: its open rows are being mirrored, so the
        // captions wait for them rather than vanishing and reappearing.
        if (s === "idle" || s === "error") voiceCaptions.end();
      },
      onCallStarted: (callId) => {
        if (voiceRef.current === client) voiceCaptions.start(callId);
      },
      onTranscript: (fragment) => {
        if (voiceRef.current === client) voiceCaptions.push(fragment);
      },
    });
    voiceRef.current = client;
    void client.start().catch((error) => {
      if (voiceRef.current !== client) return;
      setVoiceState("error");
      setVoiceError(errorMessage(error, "Voice call failed"));
      voiceCaptions.end();
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
      {/* Header. On desktop it is also the grab bar: a press anywhere on it
			    but its buttons starts a move. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2.5 border-b border-divider px-4 py-2.5",
          onGrab && DESK_PANEL_GRAB,
        )}
        onPointerDown={
          onGrab
            ? (event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest("button")
                )
                  return;
                onGrab(event);
              }
            : undefined
        }
      >
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
              : voiceStatus[voiceState]}
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
            voiceCaptions={voiceCaptions}
            voiceSend={
              voiceActive
                ? (text) =>
                    voiceRef.current?.sendText(text) ?? Promise.resolve(false)
                : undefined
            }
            // The handset lives in the composer beside dictation; the header
            // label above shows the call's state.
            voiceCall={
              voiceEnabled
                ? {
                    active: voiceActive,
                    status: voiceStatus[voiceState],
                    onToggle: toggleVoice,
                  }
                : undefined
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

  // Desktop only: the phone sheet is laid out by the palette viewport.
  const floating = !phone;
  const panelRef = useRef<HTMLDivElement>(null);
  const panel = useDeskPanel(floating && open, panelRef);

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        // Base UI hears Escape on the document, so a floating Desk would
        // close under an Escape meant for the session you are working in.
        // It only takes the key from its own focus.
        if (
          floating &&
          details.reason === "escape-key" &&
          !deskPanelOwnsFocus(panelRef.current)
        ) {
          details.cancel();
          return;
        }
        onClose();
      }}
      // A floating panel shares the page: no focus trap, and neither an
      // outside press nor focus leaving it counts as a dismissal. The phone
      // sheet keeps the trap so a touch screen reader can find its way out.
      modal={floating ? false : "trap-focus"}
      disablePointerDismissal={floating}
    >
      <Modal.Content
        ref={panelRef}
        variant={floating ? "floating" : "palette"}
        keepMounted
        widthClassName={floating ? undefined : "w-[min(650px,100%)]"}
        style={
          floating
            ? {
                left: panel.rect.left,
                top: panel.rect.top,
                width: panel.rect.width,
                height: panel.rect.height,
              }
            : undefined
        }
        className={cn(
          floating
            ? [
                openOrigin === "center"
                  ? "origin-center"
                  : DESK_PANEL_ORIGIN[panel.corner],
                "rounded-b-[var(--composer-radius)]",
              ]
            : [
                "h-[min(600px,85dvh)]",
                openOrigin === "center"
                  ? "origin-center"
                  : "origin-bottom-right",
                "rounded-b-[var(--composer-radius)] transition-[scale,translate,opacity]! duration-[100ms]! data-[starting-style]:translate-y-0! data-[starting-style]:scale-[0.9]!",
              ],
        )}
        aria-label="Desk"
        // The marker ⌘J and the Escape guard find the open panel by
        // (lib/desk-panel).
        data-desk-panel=""
      >
        {(open || opened) && (
          <DeskBody
            active={open}
            phone={phone}
            onClose={onClose}
            onOpenSession={onOpenSession}
            onGrab={floating ? panel.startMove : undefined}
          />
        )}
        {/* Resize handles: pointer-only affordances along the shell's edges.
				    The panel is complete without them, so they stay out of the
				    accessibility tree rather than adding eight nameless separators. */}
        {floating &&
          DESK_PANEL_HANDLES.map((handle) => (
            <div
              key={handle.id}
              aria-hidden="true"
              className={cn(DESK_PANEL_HANDLE, handle.className)}
              onPointerDown={(event) =>
                panel.startResize(handle.id, handle.cursor, event)
              }
            />
          ))}
      </Modal.Content>
    </Modal.Root>
  );
}
