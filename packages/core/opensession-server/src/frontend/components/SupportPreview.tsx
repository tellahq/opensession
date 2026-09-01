import { mergeStylexOverrideClassName } from "../ui/cn";
import { AGENT_NAME } from "../lib/brand";
import React, { useEffect, useRef, useState } from "react";
import type { WSClientMessage, WSServerMessage } from "../lib/types";
import {
  fetchModels,
  fetchPlainThreadById,
  type ModelOption,
} from "../lib/api";
import { Composer } from "./Composer";
import { useCurrentUser } from "./UserPicker";
import { ConversationPane } from "./ConversationPane";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { resolveNewSessionModel } from "../lib/default-model-pref";
import { InlineAlert } from "../ui/state";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  hFull: {
    height: "100%",
  },
  minH0: {
    minHeight: "0",
  },
  wFull: {
    width: "100%",
  },
  maxW760px: {
    maxWidth: "760px",
  },
  mxAuto: {
    marginInline: "auto",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  pb5: {
    paddingBottom: "calc(4px * 5)",
  },
  shrink0: {
    flexShrink: "0",
  },
  mt25: {
    marginTop: "calc(4px * 2.5)",
  },
});

interface Props {
  /** The Plain thread id — the preview's key. */
  threadId: string;
  connected: boolean;
  send: (msg: WSClientMessage) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  /** Navigate into a session (the triage button resolves to one over HTTP). */
  onOpenSession: (id: string) => void;
}

/**
 * Session-less support-ticket view: what a sidebar Support row opens when no
 * session is linked to the Plain thread yet. The conversation itself is the
 * shared ConversationPane (also the workspace Conversation tab); this wrapper
 * adds the composer at the bottom that creates a fresh linked session on the
 * first message (`create_session` with `plainThreadId` — the server files it
 * under the ticket's one workspace) — App navigates into it on
 * `session_created` exactly like the PR preview.
 */
export function SupportPreview({
  threadId,
  connected,
  send,
  addHandler,
  onOpenSession,
}: Props) {
  const draftKey = `support-preview:${threadId}`;
  const [prompt, setPrompt] = useState(() => loadDraft(draftKey).text);
  useEffect(() => {
    saveDraft(draftKey, { text: prompt });
  }, [draftKey, prompt]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [ticketName, setTicketName] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(""); // "" = default
  const currentUser = useCurrentUser();

  // The workspace-name hint for the create (the pane loads the full thread
  // itself; this fetch only feeds the title fallback and is best-effort).
  useEffect(() => {
    let alive = true;
    fetchPlainThreadById(threadId)
      .then((t) => {
        if (alive)
          setTicketName(
            t?.title || t?.customer?.name || t?.customer?.email || null,
          );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [threadId]);

  useEffect(() => {
    fetchModels()
      .then(async (m) => {
        setModels(m.models);
        setDefaultModel(m.default);
        // Preselect this person's own default model and engine (Settings →
        // Preferences); "" keeps the workspace default.
        const preselect = await resolveNewSessionModel(m);
        if (preselect) setModel((current) => current || preselect);
      })
      .catch(() => {});
  }, []);

  // Success navigates away on session_created (App handles it); on failure the
  // `starting` lock would stick forever — reset on server error or timeout
  // (same pattern as the PR preview).
  useEffect(() => {
    return addHandler((msg) => {
      if (msg.type === "error" && startingRef.current) {
        clearTimeout(startTimer.current);
        startingRef.current = false;
        setStarting(false);
        setStartError(msg.message || "Failed to start the session.");
      } else if (msg.type === "session_created" && startingRef.current) {
        clearDraft(draftKey);
      }
    });
  }, [addHandler, draftKey]);
  useEffect(() => () => clearTimeout(startTimer.current), []);

  function handleStart() {
    const q = prompt.trim();
    if (!q || starting || !connected) return;
    setStarting(true);
    startingRef.current = true;
    setStartError(null);
    clearTimeout(startTimer.current);
    startTimer.current = setTimeout(() => {
      if (!startingRef.current) return;
      startingRef.current = false;
      setStarting(false);
      setStartError(
        `${AGENT_NAME} didn't respond. Check your connection and try again.`,
      );
    }, 15_000);
    send({
      type: "create_session",
      mode: "ask",
      branch: "",
      prompt: q,
      user: currentUser,
      plainThreadId: threadId,
      // Title hint for a first-time workspace resolve (the server files the
      // session under the ticket's ONE workspace — see workspace-resolve.ts).
      createWorkspace: {
        name: (ticketName ? `Support: ${ticketName}` : "Support ticket").slice(
          0,
          80,
        ),
      },
      ...(model ? { model } : {}),
    });
    // App navigates into the session on session_created
  }

  return (
    <div {...stylex.props(sx.flex, sx.flexCol, sx.hFull, sx.minH0)}>
      <ConversationPane threadId={threadId} onOpenSession={onOpenSession} />

      <div
        {...stylex.props(
          sx.wFull,
          sx.maxW760px,
          sx.mxAuto,
          sx.px5,
          sx.pb5,
          sx.shrink0,
        )}
      >
        <Composer
          value={prompt}
          onChange={setPrompt}
          config={{
            placeholder: starting
              ? "Starting…"
              : "Start a session on this ticket…",
            disabled: starting,
            sendDisabled: starting || !connected || !prompt.trim(),
            sendTitle: "Start session on this ticket (Enter)",
            models,
            defaultModel,
            model,
            modelTitle: "Model for this session",
          }}
          actions={{
            onSend: handleStart,
            onModelChange: setModel,
          }}
        />
        {startError && (
          <InlineAlert className={mergeStylexOverrideClassName("", sx.mt25)}>
            {startError}
          </InlineAlert>
        )}
      </div>
    </div>
  );
}
