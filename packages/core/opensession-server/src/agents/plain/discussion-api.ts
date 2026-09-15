/**
 * Plain discussion (Ask Sidekick) API for the custom internal agent.
 *
 * Raw GraphQL over fetch: the pinned @team-plain/typescript-sdk predates
 * discussions and has none of these mutations. The agent uses its own API key
 * (`PLAIN_AGENT_API_KEY`, the Custom-agent machine user) so the picker entry
 * and the thread-triage machine user stay separate identities; it falls back
 * to `PLAIN_API_KEY` for a single-key install.
 *
 * Calls for one discussion are serialized (withDiscussionOrder) so tool-call
 * reports, the answer and the status change land in the order they happened.
 */
import { plainApiUrl } from "../../server/config";

export type DiscussionAgentStatus = "IN_PROGRESS" | "IDLE";
export type DiscussionToolCallStatus = "PENDING" | "SUCCESS" | "ERROR";

/** Plain's documented limits for tool-call reports. */
export const TOOL_CALL_TEXT_MAX_CHARS = 2000;
export const TOOL_CALL_ERROR_MAX_CHARS = 4000;

function agentApiKey(): string {
  return process.env.PLAIN_AGENT_API_KEY || process.env.PLAIN_API_KEY || "";
}

export function discussionAgentConfigured(): boolean {
  return agentApiKey().length > 0;
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const key = agentApiKey();
  if (!key)
    throw new Error("PLAIN_AGENT_API_KEY (or PLAIN_API_KEY) is not set");
  const res = await fetch(plainApiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Plain API responded ${res.status}`);
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length)
    throw new Error(json.errors.map((e) => e.message).join("; "));
  if (!json.data) throw new Error("Plain API returned no data");
  return json.data;
}

type MutationError = { message: string; code?: string } | null | undefined;

function assertOk(name: string, error: MutationError): void {
  if (error)
    throw new Error(
      `${name} failed: ${error.message}${error.code ? ` (${error.code})` : ""}`,
    );
}

let machineUserId: Promise<string> | null = null;

/** The machine user behind the agent key, resolved once. An explicit
 *  `PLAIN_AGENT_MACHINE_USER_ID` skips the lookup. */
export function agentMachineUserId(): Promise<string> {
  const pinned = process.env.PLAIN_AGENT_MACHINE_USER_ID?.trim();
  if (pinned) return Promise.resolve(pinned);
  if (!machineUserId) {
    machineUserId = gql<{ myMachineUser: { id: string } | null }>(
      `query { myMachineUser { id } }`,
      {},
    ).then(
      (d) => {
        if (!d.myMachineUser?.id)
          throw new Error("myMachineUser returned nothing for the agent key");
        return d.myMachineUser.id;
      },
      (e) => {
        machineUserId = null;
        throw e;
      },
    );
  }
  return machineUserId;
}

/** A per-key promise chain: each call runs after every earlier call for
 *  the same key, whether that one succeeded or failed. */
export function keyedOrder(): <T>(
  key: string,
  fn: () => Promise<T>,
) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return (key, fn) => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(key, next);
    next
      .catch(() => {})
      .finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
    return next;
  };
}

/** Run `fn` after every earlier API call queued for this discussion. */
export const withDiscussionOrder = keyedOrder();

export async function sendDiscussionMessage(
  discussionId: string,
  markdownContent: string,
): Promise<void> {
  const d = await gql<{ sendDiscussionMessage: { error: MutationError } }>(
    `mutation($input: SendDiscussionMessageInput!) {
      sendDiscussionMessage(input: $input) { error { message code } }
    }`,
    { input: { discussionId, markdownContent } },
  );
  assertOk("sendDiscussionMessage", d.sendDiscussionMessage.error);
}

export async function updateDiscussionAgentStatus(
  discussionId: string,
  agentStatus: DiscussionAgentStatus,
): Promise<void> {
  const d = await gql<{
    updateDiscussionAgentStatus: { error: MutationError };
  }>(
    `mutation($input: UpdateDiscussionAgentStatusInput!) {
      updateDiscussionAgentStatus(input: $input) { error { message code } }
    }`,
    { input: { discussionId, agentStatus } },
  );
  assertOk("updateDiscussionAgentStatus", d.updateDiscussionAgentStatus.error);
}

export async function upsertDiscussionToolCall(input: {
  discussionId: string;
  toolCallId: string;
  status: DiscussionToolCallStatus;
  text: string;
  error?: string;
}): Promise<void> {
  const d = await gql<{ upsertDiscussionToolCall: { error: MutationError } }>(
    `mutation($input: UpsertDiscussionToolCallInput!) {
      upsertDiscussionToolCall(input: $input) { error { message code } }
    }`,
    {
      input: {
        discussionId: input.discussionId,
        toolCallId: input.toolCallId,
        status: input.status,
        text: input.text.slice(0, TOOL_CALL_TEXT_MAX_CHARS),
        ...(input.status === "ERROR"
          ? {
              error: (input.error || "failed").slice(
                0,
                TOOL_CALL_ERROR_MAX_CHARS,
              ),
            }
          : {}),
      },
    },
  );
  assertOk("upsertDiscussionToolCall", d.upsertDiscussionToolCall.error);
}

export async function requestDiscussionToolCallApproval(input: {
  discussionId: string;
  toolCallId: string;
  justification: string;
}): Promise<void> {
  const d = await gql<{
    requestDiscussionToolCallApproval: { error: MutationError };
  }>(
    `mutation($input: RequestDiscussionToolCallApprovalInput!) {
      requestDiscussionToolCallApproval(input: $input) { error { message code } }
    }`,
    {
      input: {
        discussionId: input.discussionId,
        toolCallId: input.toolCallId,
        justification: input.justification.slice(0, TOOL_CALL_ERROR_MAX_CHARS),
      },
    },
  );
  assertOk(
    "requestDiscussionToolCallApproval",
    d.requestDiscussionToolCallApproval.error,
  );
}
