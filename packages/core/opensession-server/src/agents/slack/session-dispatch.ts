/** Slack is an ingress, not an agent backend. Native session creation owns
 * tools, workspace/Sandbox selection, credentials, admission and recovery. */
import { getSessionControl } from "../../server/session-control";
import { findSessionAsync } from "../../server/session-cache";
import { forkHandoffContext } from "../../server/session-create";
import {
  linkThreadInIndex,
  sessionForThread,
  linkSlackConversation,
  sessionForSlackConversation,
} from "../../server/slack-links";
import {
  getRepo,
  isSharedCheckoutDir,
  repoForPathOrNull,
} from "../../server/worktree";
import {
  githubLoginForTrustedSlackId,
  slackIdToFirstName,
} from "../../server/shared/user-mappings";
import { STAGED_UPLOADS_DIR } from "../../server/uploads";
import { downloadSlackAttachments, getChannelKind } from "./slack-api";
import { renderMemoryForPrompt } from "./memory";
import { loadSession } from "./state";
import { saveQueueToDisk, type QueuedMessage } from "./queue";

export async function dispatchSlackSessionMessage(
  sessionKey: string,
  message: QueuedMessage,
  cancelled: () => boolean = () => false,
): Promise<string> {
  const control = getSessionControl();
  const checkCancelled = () => {
    if (cancelled())
      throw new Error("Slack message cancelled before admission");
  };
  checkCancelled();
  const linked =
    sessionForThread(message.channel, message.threadTs) ||
    sessionForSlackConversation(sessionKey);
  const deliver = async (target: string): Promise<string> => {
    // A crash between native acceptance and removing the Slack queue head
    // must not turn an already accepted opening prompt into a second turn.
    const origin = (await control.getSession(target))?.slackOrigin;
    if (
      origin?.messageTs === message.messageTs &&
      origin.channel === message.channel
    )
      return target;
    const attachments = message.files?.length
      ? await downloadSlackAttachments(message.files, STAGED_UPLOADS_DIR)
      : undefined;
    checkCancelled();
    const result = await control.deliverToSession(
      target,
      message.prompt + (attachments?.note ? `\n\n${attachments.note}` : ""),
      message.userId,
      {
        busy: "queue",
        deliveryId: `slack:${message.channel}:${message.messageTs}`,
        slackReplyTo: {
          channel: message.channel,
          threadTs: message.threadTs,
          title: message.cardTitle,
        },
        images: attachments?.images,
        imageUrls: attachments?.images.map(
          (image) => `data:${image.mediaType};base64,${image.data}`,
        ),
        ...(attachments?.files.length ? { files: attachments.files } : {}),
      },
    );
    if (result.status === "error") throw new Error(result.message);
    return target;
  };
  if (linked && control.getSession(linked)) return deliver(linked);

  if (!message.nativeCreate) {
    const legacy = await loadSession(sessionKey);
    const source = legacy
      ? await findSessionAsync(`slack-${sessionKey}`)
      : undefined;
    // A historical thread can also point at automation-owned metadata.
    // Continue through that session's trust policy, never migrate it into an
    // unrestricted interactive session just because a person replied.
    if (
      source &&
      (source.automation ||
        source.automationId ||
        source.automationDescendantPolicy ||
        source.plainDiscussionId)
    )
      return deliver(source.id);
    // Existing work belongs to its current checkout. Preserve it, including
    // uncommitted edits, rather than cloning a branch into a different machine.
    const dir = legacy?.worktreeDir || message.worktreeDir;
    const owned = Boolean(dir && !(await isSharedCheckoutDir(dir)));
    const repo = getRepo(
      legacy?.repoId ||
        (dir ? (await repoForPathOrNull(dir))?.id : undefined) ||
        message.repoId,
    );
    const attachments = message.files?.length
      ? await downloadSlackAttachments(message.files, STAGED_UPLOADS_DIR)
      : undefined;
    let memory = "";
    try {
      const channel = await getChannelKind(message.channel);
      memory = await renderMemoryForPrompt(
        {
          channel: message.channel,
          userId: message.userId,
          isDM: channel.isDM,
          isPrivate: channel.isPrivate,
        },
        message.prompt,
      );
    } catch (error) {
      console.warn("[slack] Could not load channel memory:", error);
    }
    const handoff = source
      ? await forkHandoffContext({ source, canFork: false, needsHandoff: true })
      : "";
    checkCancelled();
    message.nativeCreate = {
      requestId: `slack:${message.channel}:${message.messageTs}`,
      requestScope: `slack:${sessionKey}`,
      prompt: [message.prompt, attachments?.note, memory, handoff]
        .filter(Boolean)
        .join("\n\n"),
      user: slackIdToFirstName(message.userId) || message.userName,
      createdByLogin: githubLoginForTrustedSlackId(message.userId) || undefined,
      repo: repo.id,
      // New Slack questions follow native code-session policy. Migrating a
      // legacy session must retain an explicitly read-only ask policy.
      mode: source?.mode ?? legacy?.mode ?? "code",
      branch: owned ? legacy?.branch || message.branch : undefined,
      ...(owned ? { sandbox: "local" as const } : {}),
      model: legacy?.model,
      images: attachments?.images.map(
        (image) => `data:${image.mediaType};base64,${image.data}`,
      ),
      ...(attachments?.files.length ? { files: attachments.files } : {}),
      slackOrigin: {
        sessionKey,
        channel: message.channel,
        threadTs: message.threadTs,
        messageTs: message.messageTs,
        ...(message.cardTitle ? { cardTitle: message.cardTitle } : {}),
      },
    };
    // Freeze the create identity before native admission. Recovery must not
    // rebuild it from newer memory, a changed legacy transcript or attachments.
    await saveQueueToDisk();
  }
  checkCancelled();
  const created = await control.createSession(message.nativeCreate);
  if (cancelled()) await control.cancelSession(created.id);
  linkSlackConversation(created.id, sessionKey);
  linkThreadInIndex(created.id, message.channel, message.threadTs);
  return created.id;
}
