import { useEffect, useState } from "react";
import {
  fetchFileMentions,
  fetchMentionSuggestions,
  fetchSkillMentions,
  type ModelOption,
  type ProviderAccountOption,
} from "../lib/api";
import { loadDraft, saveDraft } from "../lib/drafts";
import type { FileAttachment } from "../lib/images";
import type { UnifiedSession, WSClientMessage } from "../lib/types";
import { Composer } from "./Composer";
import { CoordinatorMenuItems } from "./threads/CoordinatorMenuItems";
import { useCurrentUser } from "./UserPicker";

/** What a reply composer needs from the app around it. */
export interface ReplyComposerCatalog {
  connected: boolean;
  models: ModelOption[];
  defaultModel: string;
  accounts: ProviderAccountOption[];
  send: (msg: WSClientMessage) => void;
}

/**
 * The full shared Composer wired to a session that is not the one open: a
 * catch-up card's, or a thread open beside its conversation. A reply here has
 * the same reach as one from the session view: images and files, model,
 * reasoning effort, a pinned subscription, a goal, dictation, @-mentions and
 * /-skills, stopping a run, and queueing or steering while it works. Model,
 * subscription and goal changes route through the /model, /account and /goal
 * slash commands (persisted and broadcast server-side), as in SessionViewer.
 * Linear-owned sessions keep the model fixed (that's the owning agent's call)
 * but still get attachments and effort.
 */
export function SessionReplyComposer({
  target,
  catalog,
  placeholder = "Reply…",
  onReplied,
}: {
  target: UnifiedSession;
  catalog: ReplyComposerCatalog;
  placeholder?: string;
  onReplied?: () => void;
}) {
  const { connected, models, defaultModel, accounts, send } = catalog;
  const currentUser = useCurrentUser();
  // Share the session's draft with the main session view (same key), so a
  // reply half-typed here shows up there and vice versa. Images and files are
  // parked in the same draft record (Composer only owns the text).
  const draftKey = `session:${target.id}`;
  const [images, setImages] = useState<string[]>(
    () => loadDraft(draftKey).images,
  );
  const [files, setFiles] = useState<FileAttachment[]>(
    () => loadDraft(draftKey).files,
  );
  useEffect(() => {
    saveDraft(draftKey, { images, files });
  }, [draftKey, images, files]);

  const [model, setModel] = useState(target.model || "");
  const [accountId, setAccountId] = useState(target.accountId || "");
  const [effort, setEffort] = useState("high");
  // Optimistic goal (the /goal command persists but doesn't broadcast a live
  // update); `undefined` defers to the session's stored goal.
  const [goalOverride, setGoalOverride] = useState<string | null | undefined>(
    undefined,
  );
  const currentGoal =
    goalOverride !== undefined ? goalOverride : (target.goal ?? null);
  // Stop pressed and the run not settled yet; a new run clears it.
  const [stopping, setStopping] = useState(false);
  const running = !!target.isRunning;
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);

  const isNative = target.source === "opensession";
  // Send the reply into the target session (images fold in as content blocks;
  // files route to the queue server-side).
  function handleSend(
    raw: string,
    opts?: { steer?: boolean; pastedTexts?: string[] },
  ): boolean {
    const text = raw.trim();
    const pastedTexts = opts?.pastedTexts ?? [];
    if (
      !text &&
      images.length === 0 &&
      files.length === 0 &&
      pastedTexts.length === 0
    )
      return false;
    if (!connected) return false;
    // Prefer the staged disk path (HTTP upload); fall back to inline dataUrl.
    const filePayload = files.map((f) =>
      f.path
        ? { name: f.name, path: f.path }
        : { name: f.name, dataUrl: f.dataUrl },
    );
    const message: Extract<WSClientMessage, { type: "prompt" }> = {
      type: "prompt",
      sessionId: target.id,
      content: text,
      user: currentUser,
      effort,
    };
    if (images.length > 0) message.images = images;
    if (files.length > 0) message.files = filePayload;
    if (pastedTexts.length > 0) message.pastedTexts = pastedTexts;
    if (running && opts?.steer) message.busyMode = "steer";
    send(message);
    setImages([]);
    setFiles([]);
    onReplied?.();
    return true;
  }

  function handleModelChange(next: string) {
    const targetModel = next || defaultModel;
    if (!targetModel || targetModel === (model || defaultModel)) return;
    setModel(next);
    send({
      type: "prompt",
      sessionId: target.id,
      content: `/model ${targetModel}`,
      user: currentUser,
    });
  }
  function handleAccountChange(next: string) {
    if (next === (accountId || "")) return;
    setAccountId(next);
    const acct = next ? accounts.find((a) => a.id === next) : null;
    send({
      type: "prompt",
      sessionId: target.id,
      content: next ? `/account ${acct?.id || next}` : "/account auto",
      user: currentUser,
    });
  }
  function handleSetGoal(goal: string | null) {
    setGoalOverride(goal);
    send({
      type: "prompt",
      sessionId: target.id,
      content: goal ? `/goal ${goal}` : "/goal clear",
      user: currentUser,
    });
  }

  return (
    <Composer
      config={{
        draftKey,
        placeholder: connected ? placeholder : "Not connected",
        disabled: !connected,
        sendDisabled: (text) =>
          !text.trim() && images.length === 0 && files.length === 0,
        busy: running,
        stopping,
        images,
        files,
        models,
        defaultModel,
        model,
        modelDisabled: !isNative && target.source !== "slack",
        modelTitle:
          isNative || target.source === "slack"
            ? "Switch the model for this session"
            : "Set the model from the owning agent (its session file is agent-owned)",
        effort,
        accounts: isNative ? accounts : undefined,
        accountId,
        goal: currentGoal,
      }}
      actions={{
        onSend: handleSend,
        onStop: () => {
          setStopping(true);
          send({ type: "cancel", sessionId: target.id });
        },
        onImagesChange: setImages,
        onFilesChange: setFiles,
        onModelChange: handleModelChange,
        onEffortChange: setEffort,
        onAccountChange: isNative ? handleAccountChange : undefined,
        onSetGoal: isNative ? handleSetGoal : undefined,
        mentionFetch: (query) => fetchFileMentions(query, target.id),
        paletteFetch: (query) =>
          fetchMentionSuggestions(query, target.id, currentUser),
        skillsFetch: (query) => fetchSkillMentions(query, target.id),
      }}
      menuExtra={
        isNative && !target.desk
          ? ({ close }) => (
              <CoordinatorMenuItems session={target} close={close} />
            )
          : undefined
      }
    />
  );
}
