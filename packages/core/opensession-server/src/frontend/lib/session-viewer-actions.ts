import type { Dispatch, SetStateAction } from "react";
import { BASE_PATH } from "./base";
import type { SlackSent } from "../components/ShippedChangeComposer";
import type { UnifiedSession, SessionSlackShare } from "./types";
import {
  archiveSessionApi,
  deleteSessionApi,
  moveSessionToBranchApi,
} from "./api";
import {
  cancelSlackComposer,
  openSlackComposer,
  reconnectSlack,
  sendSlackComposer,
  shareShippedChange,
  undoShippedChange,
  undoSlackComposer,
} from "./api/shipped-changes";
import { ApiError } from "./api/request";
import { absoluteLink, sessionPath, workspacePanePath } from "./share-link";

type Toast = (message: string) => void;
export type SlackComposer = {
  id: string;
  message: string;
  channel?: string;
  images: string[];
};
type ShareLink = (
  link: string,
  options: { toast: string; title?: string },
) => void;

interface ShippedIdentity {
  sessionId: string;
  mergedPr?: {
    repo?: string;
    branch?: string;
  };
}

interface ShippedSetters {
  setStatus: Dispatch<SetStateAction<"idle" | "sharing">>;
  setReconnectRequired: Dispatch<SetStateAction<boolean>>;
  setShare: Dispatch<SetStateAction<SessionSlackShare | null>>;
}

interface ShippedShareInput {
  message: string;
  channel: string;
  screenshots: string[];
}

export async function shareShippedChangeAction({
  identity,
  setters,
  input,
  toast,
}: {
  identity: ShippedIdentity;
  setters: ShippedSetters;
  input: ShippedShareInput;
  toast: Toast;
}) {
  if (!identity.mergedPr) return;
  setters.setStatus("sharing");
  try {
    const result = await shareShippedChange(identity.sessionId, {
      repo: identity.mergedPr.repo,
      branch: identity.mergedPr.branch,
      message: input.message,
      channel: input.channel,
      screenshots: input.screenshots,
    });
    setters.setStatus("idle");
    setters.setReconnectRequired(false);
    if (result.share) setters.setShare(result.share);
    else toast("This post was already sent");
  } catch (error) {
    setters.setStatus("idle");
    if (
      error instanceof ApiError &&
      error.status === 403 &&
      /Reconnect Slack/.test(error.message)
    ) {
      setters.setReconnectRequired(true);
      toast("Reconnect Slack to add image access");
    } else {
      toast(
        error instanceof Error
          ? error.message
          : "Couldn't share the shipped update",
      );
    }
  }
}

export async function undoShippedChangeAction({
  sessionId,
  at,
  setShare,
  toast,
}: {
  sessionId: string;
  at: string;
  setShare: Dispatch<SetStateAction<SessionSlackShare | null>>;
  toast: Toast;
}) {
  try {
    await undoShippedChange(sessionId, at);
    setShare(null);
    toast("Removed from Slack");
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : "Couldn't undo the Slack message",
    );
  }
}

export async function reconnectShippedSlackAction({
  setReconnectRequired,
  toast,
}: {
  setReconnectRequired: Dispatch<SetStateAction<boolean>>;
  toast: Toast;
}) {
  try {
    await reconnectSlack();
    setReconnectRequired(false);
    toast("Approve image access in Slack, then send again");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Couldn't reconnect Slack");
  }
}

interface ComposerSetters {
  setComposer: Dispatch<SetStateAction<SlackComposer | null>>;
  setStatus: Dispatch<SetStateAction<"idle" | "sharing">>;
  setReconnect: Dispatch<SetStateAction<boolean>>;
  setSent: Dispatch<SetStateAction<SlackSent | null>>;
}

export async function sendComposedSlackMessageAction({
  sessionId,
  composer,
  input,
  setters,
  toast,
}: {
  sessionId: string;
  composer: SlackComposer | null;
  input: ShippedShareInput;
  setters: ComposerSetters;
  toast: Toast;
}) {
  if (!composer) return;
  setters.setStatus("sharing");
  try {
    const result = await sendSlackComposer(sessionId, {
      requestId: composer.id,
      message: input.message,
      channel: input.channel,
      screenshots: input.screenshots,
    });
    setters.setComposer(null);
    setters.setStatus("idle");
    setters.setSent({
      channelName: result.channel.name,
      permalink: result.permalink,
      receiptKey: composer.id,
      channelId: result.channel.id,
      ts: result.ts,
    });
  } catch (error) {
    setters.setStatus("idle");
    if (
      error instanceof ApiError &&
      error.status === 403 &&
      /Reconnect Slack/.test(error.message)
    ) {
      setters.setReconnect(true);
      toast("Reconnect Slack to add image access");
    } else {
      toast(error instanceof Error ? error.message : "Couldn't send to Slack");
    }
  }
}

export async function undoComposedSlackMessageAction({
  sessionId,
  sent,
  setSent,
  toast,
}: {
  sessionId: string;
  sent: SlackSent;
  setSent: Dispatch<SetStateAction<SlackSent | null>>;
  toast: Toast;
}) {
  if (!sent.channelId || !sent.ts) return;
  try {
    await undoSlackComposer(sessionId, {
      channel: sent.channelId,
      ts: sent.ts,
    });
    setSent(null);
    toast("Removed from Slack");
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : "Couldn't undo the Slack message",
    );
  }
}

export async function cancelComposedSlackMessageAction({
  sessionId,
  composer,
  setComposer,
  toast,
}: {
  sessionId: string;
  composer: SlackComposer | null;
  setComposer: Dispatch<SetStateAction<SlackComposer | null>>;
  toast: Toast;
}) {
  if (!composer) return;
  try {
    await cancelSlackComposer(sessionId, composer.id);
    setComposer(null);
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : "Couldn't close the Slack composer",
    );
  }
}

export async function openSlackComposerAction({
  sessionId,
  latestAssistantMessage,
  setters,
  closeOverflow,
  scrollToLatest,
  toast,
}: {
  sessionId: string;
  latestAssistantMessage: string;
  setters: ComposerSetters;
  closeOverflow: () => void;
  scrollToLatest: (behavior: ScrollBehavior) => void;
  toast: Toast;
}) {
  closeOverflow();
  try {
    const request = await openSlackComposer(sessionId, latestAssistantMessage);
    setters.setComposer(request);
    setters.setStatus("idle");
    setters.setReconnect(false);
    setters.setSent(null);
    requestAnimationFrame(() => scrollToLatest("smooth"));
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : "Couldn't open the Slack composer",
    );
  }
}

interface ShareSessionContext {
  session: UnifiedSession;
  workspaceName?: string;
  workspaceScoped: boolean;
}

interface SharePaneContext {
  showReview: boolean;
  showConversation: boolean;
  showVideo: boolean;
  subagentIds: string[];
}

export function shareSessionAction({
  context,
  pane,
  shareLink,
}: {
  context: ShareSessionContext;
  pane: SharePaneContext;
  shareLink: ShareLink;
}) {
  const path = context.workspaceScoped
    ? `${BASE_PATH}/workspace/${encodeURIComponent(context.session.workspaceId || "")}`
    : (() => {
        const activePane = pane.showReview
          ? "review"
          : pane.showConversation
            ? "conversation"
            : pane.showVideo
              ? "video"
              : null;
        return activePane && context.session.workspaceId
          ? workspacePanePath(context.session.workspaceId, activePane)
          : sessionPath(context.session, pane.subagentIds);
      })();
  shareLink(absoluteLink(path), {
    toast: "Link copied",
    title: context.workspaceName || context.session.title || undefined,
  });
}

interface BranchActionState {
  busy: "move" | "create" | null;
  setBusy: Dispatch<SetStateAction<"move" | "create" | null>>;
  closeOverflow: () => void;
  closeConfirm: () => void;
}

export async function moveSessionToBranchAction({
  sessionId,
  isBusy,
  state,
  toast,
}: {
  sessionId: string;
  isBusy: boolean;
  state: BranchActionState;
  toast: Toast;
}) {
  if (isBusy || state.busy) return;
  state.setBusy("move");
  try {
    const result = await moveSessionToBranchApi(sessionId);
    state.closeOverflow();
    state.closeConfirm();
    toast(
      result.copiedFiles
        ? `Moved to ${result.branch} · ${result.copiedFiles} file${result.copiedFiles === 1 ? "" : "s"} copied`
        : `Moved to ${result.branch}`,
    );
  } catch (error) {
    toast(
      error instanceof Error ? error.message : "Could not move to a branch",
    );
  }
  state.setBusy(null);
}

export async function moveAndCreatePrAction({
  sessionId,
  connected,
  isBusy,
  state,
  requestCreatePr,
  toast,
}: {
  sessionId: string;
  connected: boolean;
  isBusy: boolean;
  state: BranchActionState;
  requestCreatePr: () => void;
  toast: Toast;
}) {
  if (!connected || isBusy || state.busy) return;
  state.setBusy("create");
  try {
    const result = await moveSessionToBranchApi(sessionId);
    state.closeConfirm();
    requestCreatePr();
    toast(`Moved to ${result.branch}. Creating PR…`);
  } catch (error) {
    toast(
      error instanceof Error ? error.message : "Could not move to a branch",
    );
  }
  state.setBusy(null);
}

export async function deleteSessionAction({
  sessionId,
  cleanWorktree,
  setLabel,
  setDeleting,
  setConfirmOpen,
  goBack,
}: {
  sessionId: string;
  cleanWorktree: boolean;
  setLabel: Dispatch<SetStateAction<string>>;
  setDeleting: Dispatch<SetStateAction<boolean>>;
  setConfirmOpen: Dispatch<SetStateAction<boolean>>;
  goBack: () => void;
}) {
  setLabel(
    cleanWorktree ? "Deleting session and worktree…" : "Deleting session…",
  );
  setDeleting(true);
  try {
    await deleteSessionApi(sessionId, cleanWorktree);
    // Leave the overlay up through the navigation so it never flashes back to
    // the (now-deleted) session view.
    goBack();
  } catch (error) {
    alert(
      `Delete failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    setDeleting(false);
    setConfirmOpen(false);
  }
}

interface ArchiveCallbacks {
  onArchive?: () => void;
  onArchived?: (stoppedRun: boolean) => void;
  goBack: () => void;
}

interface ArchiveSetters {
  setArchiving: Dispatch<SetStateAction<boolean>>;
  setOverflowOpen: Dispatch<SetStateAction<boolean>>;
}

// Archive is the reversible "I'm done with this" — unlike delete it keeps the
// session (and worktree) and just tucks it into the Archived view, so no
// confirm step. Unarchiving from here keeps the session selected as it moves
// back into the live sidebar.
export async function archiveSessionAction({
  sessionId,
  archived,
  callbacks,
  setters,
}: {
  sessionId: string;
  archived?: boolean;
  callbacks: ArchiveCallbacks;
  setters: ArchiveSetters;
}) {
  const next = !archived;
  setters.setArchiving(true);
  setters.setOverflowOpen(false);
  if (next && callbacks.onArchive) {
    callbacks.onArchive();
    return;
  }
  try {
    const { stoppedRun } = await archiveSessionApi(sessionId, next);
    if (next) {
      callbacks.onArchived?.(stoppedRun);
      callbacks.goBack();
    }
  } catch (error) {
    alert(
      `${next ? "Archive" : "Unarchive"} failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    setters.setArchiving(false);
  }
}
