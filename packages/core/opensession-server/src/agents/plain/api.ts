/**
 * Plain and Linear API helpers for the Plain agent.
 */
import { AttachmentType, PlainClient } from "@team-plain/typescript-sdk";
import { loadTokens, getValidToken } from "../linear/oauth";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import { configuredIntegration } from "../../server/config";
import { splitNoteText } from "./notes";

const PLAIN_API_KEY = process.env.PLAIN_API_KEY || "";
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || "";

export const plain = new PlainClient({ apiKey: PLAIN_API_KEY });

/** Upload one file to Plain and return the attachment id accepted by reply/note mutations. */
export async function uploadPlainAttachment(
  customerId: string,
  fileName: string,
  bytes: Uint8Array,
  mimeType: string,
  kind: "email" | "chat" | "note" | "slack" | "ms-teams" | "discord" | "custom",
): Promise<string> {
  const attachmentType = {
    email: AttachmentType.Email,
    chat: AttachmentType.Chat,
    note: AttachmentType.Note,
    slack: AttachmentType.Slack,
    "ms-teams": AttachmentType.MsTeams,
    discord: AttachmentType.Discord,
    custom: AttachmentType.CustomTimelineEntry,
  }[kind];
  const prepared = await plain.createAttachmentUploadUrl({
    customerId,
    fileName,
    fileSizeBytes: bytes.byteLength,
    attachmentType,
  });
  if (prepared.error || !prepared.data) {
    throw new Error(prepared.error?.message || "Plain rejected the attachment");
  }

  const form = new FormData();
  for (const field of prepared.data.uploadFormData) {
    form.append(field.key, field.value);
  }
  form.append(
    "file",
    new Blob([Uint8Array.from(bytes).buffer], { type: mimeType }),
    fileName,
  );
  const uploaded = await fetchWithTimeout(
    prepared.data.uploadFormUrl,
    { method: "POST", body: form },
    60_000,
  );
  if (!uploaded.ok) {
    throw new Error(`Plain attachment upload failed (${uploaded.status})`);
  }
  return prepared.data.attachment.id;
}

/** Get thread with full timeline entries */
export async function getThreadWithMessages(threadId: string): Promise<any> {
  const query = `
    query GetThreadWithMessages($threadId: ID!) {
      thread(threadId: $threadId) {
        id
        channel
        title
        description
        status
        priority
        customer {
          id
          fullName
          email {
            email
          }
          externalId
          markedAsSpamAt {
            iso8601
          }
        }
        assignedTo {
          __typename
          ... on User {
            id
            fullName
            publicName
          }
          ... on MachineUser {
            id
            fullName
          }
        }
        labels {
          id
          labelType {
            id
            name
            icon
          }
        }
        # Plain's own inbound/outbound tracking — it deliberately ignores
        # autoresponders, so this is the honest "is the customer still
        # waiting on a human?" signal rather than one we infer.
        lastInboundMessageInfo {
          timestamp {
            iso8601
          }
        }
        firstOutboundMessageInfo {
          timestamp {
            iso8601
          }
        }
        lastOutboundMessageInfo {
          timestamp {
            iso8601
          }
        }
        timelineEntries(first: 100) {
          edges {
            node {
              id
              timestamp {
                iso8601
              }
              actor {
                __typename
                ... on UserActor {
                  userId
                  user {
                    fullName
                    email
                  }
                }
                ... on CustomerActor {
                  customerId
                  customer {
                    fullName
                    email {
                      email
                    }
                  }
                }
                ... on SystemActor {
                  systemId
                }
                ... on MachineUserActor {
                  machineUserId
                  machineUser {
                    fullName
                  }
                }
              }
              entry {
                __typename
                ... on NoteEntry {
                  noteId
                  noteText: text
                  markdown
                  attachments {
                    ...AttachmentParts
                  }
                }
                ... on EmailEntry {
                  emailId
                  from {
                    name
                    email
                  }
                  to {
                    name
                    email
                  }
                  subject
                  textContent
                  attachments {
                    ...AttachmentParts
                  }
                }
                ... on ChatEntry {
                  chatId
                  text
                  attachments {
                    ...AttachmentParts
                  }
                }
                ... on CustomEntry {
                  title
                  components {
                    __typename
                    ... on ComponentText {
                      text
                    }
                    ... on ComponentLinkButton {
                      linkButtonUrl
                      linkButtonLabel
                    }
                  }
                  attachments {
                    ...AttachmentParts
                  }
                }
              }
            }
          }
        }
      }
    }

    fragment AttachmentParts on Attachment {
      id
      fileName
      fileMimeType
      fileSize {
        bytes
      }
    }
  `;

  const result = await plain.rawRequest({
    query,
    variables: { threadId },
  });

  if (result.error) {
    throw new Error(
      `Failed to get thread with messages: ${result.error.message}`,
    );
  }

  return (result.data as any).thread;
}

/**
 * Mint a download URL for one attachment. Plain's URLs are signed and expire
 * after ~3 minutes, so this is called per request rather than baked into the
 * thread payload. Returns null when Plain refuses, and refuses ourselves when
 * the file failed its virus scan.
 */
export async function getAttachmentDownloadUrl(
  attachmentId: string,
): Promise<{ url: string; fileName: string; mimeType: string } | null> {
  const result = await plain.rawRequest({
    query: `
      mutation CreateAttachmentDownloadUrl($input: CreateAttachmentDownloadUrlInput!) {
        createAttachmentDownloadUrl(input: $input) {
          attachmentDownloadUrl {
            downloadUrl
            attachment {
              fileName
              fileMimeType
            }
          }
          attachmentVirusScanResult
          error {
            message
          }
        }
      }
    `,
    variables: { input: { attachmentId } },
  });
  if (result.error)
    throw new Error(`Attachment download URL failed: ${result.error.message}`);

  const payload = (result.data as any)?.createAttachmentDownloadUrl;
  if (payload?.error?.message) throw new Error(payload.error.message);
  if (payload?.attachmentVirusScanResult === "INFECTED")
    throw new Error("Attachment failed its virus scan");

  const link = payload?.attachmentDownloadUrl;
  if (!link?.downloadUrl) return null;
  return {
    url: link.downloadUrl,
    fileName: link.attachment?.fileName || "attachment",
    mimeType: link.attachment?.fileMimeType || "application/octet-stream",
  };
}

/**
 * A file the customer (or we) attached to a message. Plain only hands out
 * short-lived signed URLs, so the id is all we carry — the UI loads the bytes
 * through opensession's own `/plain/attachments/:id` proxy.
 */
export interface PlainEntryAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/** A single, UI-ready message in a Plain thread's timeline. */
export interface NormalizedPlainEntry {
  id: string;
  timestamp: string;
  actorName: string;
  actorType: "customer" | "support" | "bot" | "system";
  /** "message" = a CustomEntry, e.g. the in-app support form's original message. */
  kind: "email" | "chat" | "note" | "message";
  subject?: string;
  text: string;
  attachments?: PlainEntryAttachment[];
}

/** Flatten an entry's `attachments` selection to the UI shape. */
function entryAttachments(entry: any): PlainEntryAttachment[] {
  return (entry?.attachments || [])
    .filter((a: any) => a?.id)
    .map((a: any) => ({
      id: a.id,
      fileName: a.fileName || "attachment",
      mimeType: a.fileMimeType || "application/octet-stream",
      sizeBytes: a.fileSize?.bytes ?? 0,
    }));
}

/**
 * Flatten a CustomEntry's card components to plain text: text components in
 * order, link buttons as "label: url" lines. Layout components (spacers,
 * dividers, rows) are skipped.
 */
function customEntryText(entry: any): string {
  const parts: string[] = [];
  for (const c of entry?.components || []) {
    if (c?.__typename === "ComponentText" && c.text) parts.push(c.text);
    else if (c?.__typename === "ComponentLinkButton" && c.linkButtonUrl)
      parts.push(
        c.linkButtonLabel
          ? `${c.linkButtonLabel}: ${c.linkButtonUrl}`
          : c.linkButtonUrl,
      );
  }
  return parts.join("\n\n");
}

/** A Plain thread flattened to the shape the opensession sidebar renders. */
export interface NormalizedPlainThread {
  id: string;
  title: string | null;
  status: string | null;
  priority: number | null;
  customer: {
    id: string | null;
    name: string | null;
    email: string | null;
    isSpam: boolean;
  };
  /** Workspace user (or bot) the thread is assigned to, if anyone. */
  assignee: { id: string; name: string; isBot: boolean } | null;
  /** Labels on the thread. `id` removes it, `labelTypeId` identifies the kind. */
  labels: {
    id: string;
    labelTypeId: string;
    name: string;
    icon: string | null;
  }[];
  /**
   * When the customer's still-unanswered message landed, else null. Straight
   * from Plain's inbound/outbound tracking, which ignores autoresponders — so
   * an auto-reply doesn't make a waiting customer look answered.
   */
  waitingSince: string | null;
  /** True while no human has ever replied — Plain's "needs first response". */
  awaitingFirstResponse: boolean;
  entries: NormalizedPlainEntry[];
}

/**
 * Flatten the raw `getThreadWithMessages` payload into the message list the
 * session viewer's Plain sidebar renders: customer/support/bot emails & chats,
 * custom entries (the in-app support form's message cards) plus internal notes,
 * sorted oldest-first. Status-change and other non-message timeline entries are
 * dropped.
 */
export function normalizePlainThread(thread: any): NormalizedPlainThread {
  const entries: NormalizedPlainEntry[] = [];
  for (const edge of thread?.timelineEntries?.edges || []) {
    const node = edge?.node;
    const actor = node?.actor;
    const entry = node?.entry;
    if (!entry) continue;

    let actorName = "Unknown";
    let actorType: NormalizedPlainEntry["actorType"] = "system";
    if (actor?.__typename === "CustomerActor") {
      actorName =
        actor.customer?.fullName || actor.customer?.email?.email || "Customer";
      actorType = "customer";
    } else if (actor?.__typename === "UserActor") {
      actorName = actor.user?.fullName || actor.user?.email || "Support";
      actorType = "support";
    } else if (actor?.__typename === "MachineUserActor") {
      actorName = actor.machineUser?.fullName || "Bot";
      actorType = "bot";
    } else if (actor?.__typename === "SystemActor") {
      actorName = "System";
      actorType = "system";
    }

    let kind: NormalizedPlainEntry["kind"];
    let text = "";
    let subject: string | undefined;
    if (entry.__typename === "EmailEntry") {
      kind = "email";
      subject = entry.subject || undefined;
      text = entry.textContent || "";
    } else if (entry.__typename === "ChatEntry") {
      kind = "chat";
      text = entry.text || "";
    } else if (entry.__typename === "NoteEntry") {
      kind = "note";
      text = entry.markdown || entry.noteText || "";
    } else if (entry.__typename === "CustomEntry") {
      // The in-app support form posts the customer's original message as a
      // CustomEntry via the API — the actor is our machine user, but it's the
      // customer speaking, so attribute it to them (else the thread's opening
      // message renders as an outbound bot card, or gets dropped entirely).
      kind = "message";
      subject = entry.title || undefined;
      text = customEntryText(entry);
      actorName =
        thread?.customer?.fullName ||
        thread?.customer?.email?.email ||
        "Customer";
      actorType = "customer";
    } else {
      continue; // status changes, assignments, etc. — not part of the conversation
    }
    // A message can be nothing but a screenshot — keep those, they're often
    // the whole bug report.
    const attachments = entryAttachments(entry);
    if (!text.trim() && attachments.length === 0) continue;

    entries.push({
      id: node.id,
      timestamp: node.timestamp?.iso8601 || "",
      actorName,
      actorType,
      kind,
      subject,
      text,
      ...(attachments.length ? { attachments } : {}),
    });
  }

  entries.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return {
    id: thread?.id,
    title: thread?.title || null,
    status: thread?.status || null,
    priority: thread?.priority ?? null,
    customer: {
      id: thread?.customer?.id || null,
      name: thread?.customer?.fullName || null,
      email: thread?.customer?.email?.email || null,
      isSpam: Boolean(thread?.customer?.markedAsSpamAt?.iso8601),
    },
    assignee: thread?.assignedTo?.id
      ? {
          id: thread.assignedTo.id,
          name:
            thread.assignedTo.publicName || thread.assignedTo.fullName || "?",
          isBot: thread.assignedTo.__typename === "MachineUser",
        }
      : null,
    labels: (thread?.labels || [])
      .filter((l: any) => l?.id && l?.labelType?.id)
      .map((l: any) => ({
        id: l.id,
        labelTypeId: l.labelType.id,
        name: l.labelType.name || "?",
        icon: l.labelType.icon || null,
      })),
    ...threadWaitingState(thread),
    entries,
  };
}

/**
 * Whether the customer is still waiting on us, from Plain's own message
 * tracking: they're waiting when their latest message is newer than our
 * latest reply (or we've never replied at all).
 */
function threadWaitingState(thread: any): {
  waitingSince: string | null;
  awaitingFirstResponse: boolean;
} {
  const inbound = thread?.lastInboundMessageInfo?.timestamp?.iso8601 || null;
  const outbound = thread?.lastOutboundMessageInfo?.timestamp?.iso8601 || null;
  const everReplied = Boolean(
    thread?.firstOutboundMessageInfo?.timestamp?.iso8601,
  );
  const waiting =
    inbound && (!outbound || new Date(inbound) > new Date(outbound));
  return {
    waitingSince: waiting ? inbound : null,
    awaitingFirstResponse: Boolean(waiting) && !everReplied,
  };
}

/** A TODO-queue thread summary for the Open Session Support sidebar. */
export interface SupportThreadSummary {
  id: string;
  title: string | null;
  previewText: string | null;
  status: string | null;
  statusChangedAt: string | null;
  createdAt: string | null;
  priority: number | null;
  /** Labels on the thread: id = instance (l_…), typeId = kind (lt_…). */
  labels: { id: string; typeId: string; name: string; icon: string | null }[];
  customer: { name: string | null; email: string | null };
  /** Plain user the thread is assigned to (bot = MachineUser), or null. */
  assignee: { id: string; name: string; isBot: boolean } | null;
}

/**
 * All TODO threads, newest status change first — the same ordering as Plain's
 * own Todo inbox. Feeds the sidebar's Support section.
 */
export async function listTodoThreads(
  limit: number = 50,
): Promise<SupportThreadSummary[]> {
  const query = `
    query TodoThreads($filters: ThreadsFilter, $sortBy: ThreadsSort, $first: Int!) {
      threads(filters: $filters, sortBy: $sortBy, first: $first) {
        edges {
          node {
            id
            title
            previewText
            status
            statusChangedAt {
              iso8601
            }
            createdAt {
              iso8601
            }
            priority
            assignedTo {
              __typename
              ... on User {
                id
                fullName
                publicName
              }
              ... on MachineUser {
                id
                fullName
              }
            }
            labels {
              id
              labelType {
                id
                name
                icon
              }
            }
            customer {
              fullName
              email {
                email
              }
            }
          }
        }
      }
    }
  `;

  const result = await plain.rawRequest({
    query,
    variables: {
      filters: { statuses: ["TODO"] },
      sortBy: { field: "STATUS_CHANGED_AT", direction: "DESC" },
      first: limit,
    },
  });

  if (result.error) {
    throw new Error(`Failed to list TODO threads: ${result.error.message}`);
  }

  const edges = (result.data as any).threads?.edges || [];
  return edges.map((e: any) => {
    const n = e?.node || {};
    return {
      id: n.id,
      title: n.title || null,
      previewText: n.previewText || null,
      status: n.status || null,
      statusChangedAt: n.statusChangedAt?.iso8601 || null,
      createdAt: n.createdAt?.iso8601 || null,
      priority: n.priority ?? null,
      labels: (n.labels || []).map((l: any) => ({
        id: l?.id || "",
        typeId: l?.labelType?.id || "",
        name: l?.labelType?.name || "?",
        icon: l?.labelType?.icon || null,
      })),
      customer: {
        name: n.customer?.fullName || null,
        email: n.customer?.email?.email || null,
      },
      assignee: n.assignedTo?.id
        ? {
            id: n.assignedTo.id,
            name: n.assignedTo.publicName || n.assignedTo.fullName || "?",
            isBot: n.assignedTo.__typename === "MachineUser",
          }
        : null,
    };
  });
}

/**
 * Post an internal note to a thread.
 *
 * Plain caps a note at 10,000 characters and rejects the whole mutation past
 * that, so a long body (an agent's investigation write-up, a pasted log) is
 * split into numbered parts posted in order rather than dropped. Attachments
 * ride the first part.
 */
export async function postNote(
  threadId: string,
  customerId: string,
  text: string,
  markdown?: string,
  attachmentIds: string[] = [],
): Promise<boolean> {
  const textParts = splitNoteText(text);
  const markdownParts =
    markdown && markdown !== text ? splitNoteText(markdown) : textParts;
  const total = Math.max(textParts.length, markdownParts.length);

  try {
    for (let i = 0; i < total; i++) {
      const partText = textParts[i] ?? markdownParts[i] ?? "";
      const result = await plain.createNote({
        threadId,
        customerId,
        text: partText,
        markdown: markdownParts[i] ?? partText,
        ...(i === 0 && attachmentIds.length ? { attachmentIds } : {}),
      });

      if (result.error) {
        console.error(
          `Error creating note (part ${i + 1}/${total}):`,
          result.error,
        );
        return false;
      }
    }

    console.log(
      `[plain] Posted note to thread ${threadId}${total > 1 ? ` in ${total} parts` : ""}`,
    );
    return true;
  } catch (e) {
    console.error("Error posting note:", e);
    return false;
  }
}

/** Clean up draft text — remove markdown artifacts and normalize */
export function cleanDraftText(text: string): string {
  return text
    .replace(/^>\s?/gm, "")
    .replace(/\*\*\s*\*\*/g, "")
    .replace(/^\s*\*+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Send a reply to the customer (email/chat based on thread type) */
export async function sendCustomerReply(
  threadId: string,
  customerId: string,
  text: string,
  /** Per-user Plain OAuth token — the reply is then attributed to that
   *  person instead of the workspace machine user. Auth failures fall back
   *  to the system key so the customer still gets the reply. */
  userToken?: string,
  attachmentIds: string[] = [],
): Promise<{ ok: boolean; sentAs: "user" | "system" }> {
  const cleanText = cleanDraftText(text);
  if (userToken) {
    try {
      const asUser = new PlainClient({ apiKey: userToken });
      const result = await asUser.replyToThread({
        threadId,
        textContent: cleanText,
        ...(attachmentIds.length ? { attachmentIds } : {}),
      });
      if (!result.error) {
        console.log(
          `[plain] Sent reply in thread ${threadId} as the connected user`,
        );
        return { ok: true, sentAs: "user" };
      }
      console.warn(
        "[plain] user-token reply failed, falling back to system key:",
        result.error,
      );
    } catch (e) {
      console.warn(
        "[plain] user-token reply failed, falling back to system key:",
        e,
      );
    }
  }
  try {
    const result = await plain.replyToThread({
      threadId,
      textContent: cleanText,
      ...(attachmentIds.length ? { attachmentIds } : {}),
    });

    if (result.error) {
      console.error("Error sending reply:", result.error);
      return { ok: false, sentAs: "system" };
    }

    console.log(`[plain] Sent reply to customer in thread ${threadId}`);
    return { ok: true, sentAs: "system" };
  } catch (e) {
    console.error("Error sending reply:", e);
    return { ok: false, sentAs: "system" };
  }
}

/** Statuses a human can set on a thread from the Support UI. */
export type ThreadStatusAction = "todo" | "done" | "snoozed";

/**
 * Change a thread's status the way Plain's own inbox does: Done closes it,
 * Todo (re)opens/unsnoozes it, Snoozed parks it for `durationSeconds`
 * (default 1 day, after which Plain flips it back to Todo).
 */
export async function setThreadStatus(
  threadId: string,
  status: ThreadStatusAction,
  durationSeconds?: number,
): Promise<void> {
  const result =
    status === "done"
      ? await plain.markThreadAsDone({ threadId })
      : status === "todo"
        ? await plain.markThreadAsTodo({ threadId })
        : await plain.snoozeThread({
            threadId,
            durationSeconds: Math.max(
              60,
              Math.floor(durationSeconds ?? 86_400),
            ),
          });
  if (result.error) {
    throw new Error(`Failed to mark thread ${status}: ${result.error.message}`);
  }
}

/** Plain thread priorities: 0 = Urgent, 1 = High, 2 = Normal, 3 = Low. */
export async function setThreadPriority(
  threadId: string,
  priority: number,
): Promise<void> {
  if (![0, 1, 2, 3].includes(priority)) {
    throw new Error(`Invalid priority ${priority} (0=Urgent … 3=Low)`);
  }
  const result = await plain.changeThreadPriority({ threadId, priority });
  if (result.error) {
    throw new Error(`Failed to change priority: ${result.error.message}`);
  }
}

/**
 * Mark or unmark a customer as spam. Plain tracks spam on the customer, not
 * the thread (all their future threads get filtered too); the SDK has no
 * method for these mutations, so raw GraphQL.
 */
export async function setCustomerSpam(
  customerId: string,
  spam: boolean,
): Promise<void> {
  const mutation = spam ? "markCustomerAsSpam" : "unmarkCustomerAsSpam";
  const inputType = spam
    ? "MarkCustomerAsSpamInput"
    : "UnmarkCustomerAsSpamInput";
  const result = await plain.rawRequest({
    query: `
      mutation SetCustomerSpam($input: ${inputType}!) {
        ${mutation}(input: $input) {
          error {
            message
          }
        }
      }
    `,
    variables: { input: { customerId } },
  });
  if (result.error) {
    throw new Error(`${mutation} failed: ${result.error.message}`);
  }
  const err = (result.data as any)?.[mutation]?.error;
  if (err?.message) {
    throw new Error(`${mutation} failed: ${err.message}`);
  }
}

/** Assign a thread to a workspace user, or unassign it (userId = null). */
export async function assignThreadToUser(
  threadId: string,
  userId: string | null,
): Promise<void> {
  const result = userId
    ? await plain.assignThread({ threadId, userId })
    : await plain.unassignThread({ threadId });
  if (result.error) {
    throw new Error(
      `Failed to ${userId ? "assign" : "unassign"} thread: ${result.error.message}`,
    );
  }
}

/** Rename a thread. No SDK method for this mutation, so raw GraphQL. */
export async function setThreadTitle(
  threadId: string,
  title: string,
): Promise<void> {
  const result = await plain.rawRequest({
    query: `
      mutation UpdateThreadTitle($input: UpdateThreadTitleInput!) {
        updateThreadTitle(input: $input) {
          error {
            message
          }
        }
      }
    `,
    variables: { input: { threadId, title } },
  });
  const err =
    result.error?.message ||
    (result.data as any)?.updateThreadTitle?.error?.message;
  if (err) {
    throw new Error(`Failed to rename thread: ${err}`);
  }
}

/**
 * Add and/or remove labels on a thread. Adds take label TYPE ids
 * (lt_…, the kind); removes take the label INSTANCE ids (l_…, from
 * the thread's `labels`).
 */
export async function changeThreadLabels(
  threadId: string,
  addLabelTypeIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  if (addLabelTypeIds.length) {
    const result = await plain.addLabels({
      threadId,
      labelTypeIds: addLabelTypeIds,
    });
    if (result.error) {
      throw new Error(`Failed to add labels: ${result.error.message}`);
    }
  }
  if (removeLabelIds.length) {
    const result = await plain.removeLabels({ labelIds: removeLabelIds });
    if (result.error) {
      throw new Error(`Failed to remove labels: ${result.error.message}`);
    }
  }
}

/** A workspace teammate threads can be assigned to. */
export interface PlainWorkspaceUser {
  id: string;
  name: string;
  email: string | null;
}

/**
 * Workspace users for the Assign menu. Plain's user list is full of
 * forwarding-alias accounts (billing@, privacy@, …) whose fullName IS the
 * email — those can't meaningfully own a ticket, so they're filtered out.
 */
export async function listWorkspaceUsers(): Promise<PlainWorkspaceUser[]> {
  const result = await plain.rawRequest({
    query: `
      query WorkspaceUsers($first: Int!) {
        users(first: $first) {
          edges {
            node {
              id
              fullName
              publicName
              email
              isDeleted
            }
          }
        }
      }
    `,
    variables: { first: 100 },
  });
  if (result.error) {
    throw new Error(`Failed to list users: ${result.error.message}`);
  }
  const edges = (result.data as any).users?.edges || [];
  return edges
    .map((e: any) => e?.node)
    .filter(
      (n: any) => n?.id && !n.isDeleted && n.fullName && !/@/.test(n.fullName), // alias accounts wear their email as a name
    )
    .map((n: any) => ({
      id: n.id,
      name: n.publicName || n.fullName,
      email: n.email || null,
    }))
    .sort((a: PlainWorkspaceUser, b: PlainWorkspaceUser) =>
      a.name.localeCompare(b.name),
    );
}

/** A label kind that can be put on threads (Plain's label types). */
export interface PlainLabelType {
  id: string;
  name: string;
  icon: string | null;
}

/** Active (non-archived) label types, for the Labels menu. */
export async function listLabelTypes(): Promise<PlainLabelType[]> {
  const result = await plain.rawRequest({
    query: `
      query LabelTypes($first: Int!) {
        labelTypes(first: $first) {
          edges {
            node {
              id
              name
              icon
              isArchived
            }
          }
        }
      }
    `,
    variables: { first: 100 },
  });
  if (result.error) {
    throw new Error(`Failed to list label types: ${result.error.message}`);
  }
  const edges = (result.data as any).labelTypes?.edges || [];
  return edges
    .map((e: any) => e?.node)
    .filter((n: any) => n?.id && !n.isArchived)
    .map((n: any) => ({
      id: n.id,
      name: n.name || "?",
      icon: n.icon || null,
    }))
    .sort((a: PlainLabelType, b: PlainLabelType) =>
      a.name.localeCompare(b.name),
    );
}

/** Format thread context for Claude */
export function formatThreadContext(
  thread: any,
  includeAllMessages: boolean = false,
): string {
  if (!thread) {
    return "Thread information not available.";
  }

  let context = `**Thread ID:** ${thread.id}\n`;
  context += `**Customer:** ${thread.customer.fullName || thread.customer.email?.email || thread.customer.id}\n`;
  if (thread.customer.email?.email) {
    context += `**Customer Email:** ${thread.customer.email.email}\n`;
  }
  context += `**Status:** ${thread.status}\n`;
  context += `**Priority:** ${thread.priority}\n`;

  if (thread.title) {
    context += `**Title:** ${thread.title}\n`;
  }

  if (thread.description) {
    context += `\n**Description:**\n${thread.description}\n`;
  }

  context += `\n**Conversation History:**\n\n`;

  thread.timelineEntries?.edges?.forEach((edge: any) => {
    const node = edge.node;
    const entry = node.entry;
    const actor = node.actor;
    const timestamp = node.timestamp?.iso8601 || "";

    let actorName = "Unknown";
    let actorType = "unknown";

    if (actor?.__typename === "CustomerActor") {
      actorName =
        actor.customer?.fullName || actor.customer?.email?.email || "Customer";
      actorType = "customer";
    } else if (actor?.__typename === "UserActor") {
      actorName = actor.user?.fullName || actor.user?.email || "Support";
      actorType = "support";
    } else if (actor?.__typename === "MachineUserActor") {
      actorName = actor.machineUser?.fullName || "Bot";
      actorType = "bot";
    }

    // The in-app support form posts the customer's original message as a
    // CustomEntry via the API (machine-user actor) — it's the customer
    // speaking, so treat it as theirs (else the customer-only filter below
    // drops the thread's opening message).
    if (entry?.__typename === "CustomEntry") {
      actorName =
        thread.customer?.fullName ||
        thread.customer?.email?.email ||
        "Customer";
      actorType = "customer";
    }

    if (!includeAllMessages && actorType !== "customer") {
      return;
    }

    if (entry) {
      if (entry.__typename === "EmailEntry" && entry.textContent) {
        context += `**[${actorType.toUpperCase()}] ${actorName}** (${timestamp}):\n${entry.textContent}\n\n---\n\n`;
      } else if (entry.__typename === "ChatEntry" && entry.text) {
        context += `**[${actorType.toUpperCase()}] ${actorName}** (${timestamp}):\n${entry.text}\n\n---\n\n`;
      } else if (entry.__typename === "NoteEntry" && entry.noteText) {
        context += `**[NOTE] ${actorName}** (${timestamp}):\n${entry.noteText}\n\n---\n\n`;
      } else if (entry.__typename === "CustomEntry") {
        const text = customEntryText(entry);
        if (text)
          context += `**[${actorType.toUpperCase()}] ${actorName}** (${timestamp}):\n${
            entry.title ? `${entry.title}\n\n` : ""
          }${text}\n\n---\n\n`;
      }
    }
  });

  return context;
}

/**
 * Resolve a Linear Authorization header. Prefers the Linear agent's OAuth
 * token store (~/.linear-agent-tokens.json, auto-refreshed) and falls back to
 * the LINEAR_API_KEY env var (bare for personal lin_api_ keys, Bearer otherwise).
 */
async function linearAuthHeader(): Promise<string | null> {
  const tokens = await loadTokens();
  for (const orgId of Object.keys(tokens)) {
    const token = await getValidToken(orgId, tokens);
    if (token) return `Bearer ${token}`;
  }
  if (LINEAR_API_KEY) {
    return LINEAR_API_KEY.startsWith("lin_api_")
      ? LINEAR_API_KEY
      : `Bearer ${LINEAR_API_KEY}`;
  }
  return null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const teamIdCache = new Map<string, string>();

/** Resolve a team key (e.g. "ENG") to its UUID — issueCreate only accepts UUIDs. */
async function resolveLinearTeamId(
  auth: string,
  team: string,
): Promise<string | null> {
  if (UUID_RE.test(team)) return team;
  const cached = teamIdCache.get(team);
  if (cached) return cached;

  const response = await fetchWithTimeout("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      query: `
        query TeamByKey($key: String!) {
          teams(filter: { key: { eq: $key } }, first: 1) {
            nodes { id }
          }
        }
      `,
      variables: { key: team },
    }),
  });
  const data = await response.json();
  const id = data.data?.teams?.nodes?.[0]?.id;
  if (id) {
    teamIdCache.set(team, id);
    return id;
  }
  console.error(
    `Linear team not found for key "${team}":`,
    data.errors || data,
  );
  return null;
}

/** Create a Linear issue */
export async function createLinearIssue(
  title: string,
  description: string,
  teamId?: string,
): Promise<{ id: string; identifier: string; url: string } | null> {
  const auth = await linearAuthHeader();
  if (!auth) {
    console.error(
      "No Linear credentials (OAuth token store empty and LINEAR_API_KEY unset)",
    );
    return null;
  }

  try {
    const configuredTeam = configuredIntegration("plain").linearTeamKey;
    const resolvedTeamId = await resolveLinearTeamId(
      auth,
      teamId || (typeof configuredTeam === "string" ? configuredTeam : ""),
    );
    if (!resolvedTeamId) return null;

    const response = await fetchWithTimeout("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({
        query: `
          mutation CreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue {
                id
                identifier
                url
              }
            }
          }
        `,
        variables: {
          input: {
            title,
            description,
            teamId: resolvedTeamId,
          },
        },
      }),
    });

    const data = await response.json();
    if (data.data?.issueCreate?.success) {
      return data.data.issueCreate.issue;
    }
    console.error("Linear issue creation failed:", data);
    return null;
  } catch (e) {
    console.error("Error creating Linear issue:", e);
    return null;
  }
}
