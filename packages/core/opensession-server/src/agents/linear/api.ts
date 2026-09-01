/**
 * Linear GraphQL API helpers.
 */
import type { Participant } from "./session";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";

const LINEAR_GQL = "https://api.linear.app/graphql";

async function gql(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<any> {
  const response = await fetchWithTimeout(LINEAR_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

/** Fetch a Linear user's details */
export async function fetchLinearUser(
  accessToken: string,
  userId: string,
): Promise<Participant | null> {
  try {
    const data = await gql(
      accessToken,
      `
      query GetUser($userId: String!) {
        user(id: $userId) { id name email }
      }
    `,
      { userId },
    );

    const user = data?.data?.user;
    if (user) {
      return { id: user.id, name: user.name, email: user.email || null };
    }
  } catch (e) {
    console.error(`[linear] Error fetching user ${userId}:`, e);
  }
  return null;
}

/** All activity content shapes Linear renders in an agent session timeline. */
export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  /** Asks the user for input — Linear highlights it and prompts for a reply. */
  | { type: "elicitation"; body: string }
  | { type: "error"; body: string }
  /** Tool/step row, e.g. action: "Read", parameter: "src/foo.ts". */
  | { type: "action"; action: string; parameter: string; result?: string };

/** Create agent activity. `ephemeral` (thought/action only) is replaced by the next activity. */
export async function createAgentActivity(
  accessToken: string,
  sessionId: string,
  content: AgentActivityContent,
  ephemeral?: boolean,
): Promise<void> {
  const result = await gql(
    accessToken,
    `
    mutation CreateAgentActivity($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
        agentActivity { id }
      }
    }
  `,
    {
      input: {
        agentSessionId: sessionId,
        content,
        ...(ephemeral ? { ephemeral: true } : {}),
      },
    },
  );

  if (!result.data?.agentActivityCreate?.success) {
    console.error("[linear] Failed to create agent activity:", result);
  }
}

export interface PlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/**
 * Update session metadata: external links (e.g. the web UI) and the
 * plan panel. Fire-and-forget friendly — failures only log.
 */
export async function updateAgentSession(
  accessToken: string,
  sessionId: string,
  input: {
    addedExternalUrls?: Array<{ url: string; label: string }>;
    plan?: PlanStep[];
  },
): Promise<boolean> {
  const result = await gql(
    accessToken,
    `
    mutation UpdateAgentSession($id: String!, $input: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $id, input: $input) { success }
    }
  `,
    { id: sessionId, input },
  );

  if (!result.data?.agentSessionUpdate?.success) {
    console.error(
      "[linear] Failed to update agent session:",
      JSON.stringify(result),
    );
    return false;
  }
  return true;
}

/** Fetch issue status and team */
export async function getIssueStatus(
  accessToken: string,
  issueId: string,
): Promise<{ status: string; teamId: string }> {
  const result = await gql(
    accessToken,
    `
    query GetIssue($id: String!) {
      issue(id: $id) {
        state { name }
        team { id }
      }
    }
  `,
    { id: issueId },
  );

  const status = result.data?.issue?.state?.name || "Unknown";
  const teamId = result.data?.issue?.team?.id || "";
  console.log(`[linear] Issue ${issueId} status: ${status}, team: ${teamId}`);
  return { status, teamId };
}

/** Post a comment to a Linear issue */
export async function postComment(
  accessToken: string,
  issueId: string,
  body: string,
): Promise<boolean> {
  const result = await gql(
    accessToken,
    `
    mutation CreateComment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id }
      }
    }
  `,
    { input: { issueId, body } },
  );

  if (!result.data?.commentCreate?.success) {
    console.error("[linear] Failed to create comment:", result);
    return false;
  }
  console.log(`[linear] Posted comment to issue ${issueId}`);
  return true;
}

/** Check if issue has a plan in comments */
export async function issueHasPlan(
  accessToken: string,
  issueId: string,
): Promise<boolean> {
  const result = await gql(
    accessToken,
    `
    query GetIssueComments($id: String!) {
      issue(id: $id) {
        comments { nodes { body } }
      }
    }
  `,
    { id: issueId },
  );

  const comments = result.data?.issue?.comments?.nodes || [];
  const hasPlan = comments.some(
    (c: { body: string }) =>
      c.body.includes("# Implementation Plan") ||
      c.body.includes("## Implementation Plan"),
  );
  console.log(`[linear] Issue ${issueId} has plan: ${hasPlan}`);
  return hasPlan;
}

/** Get full issue details */
export async function getIssueDetails(
  accessToken: string,
  issueId: string,
): Promise<{
  status: string;
  teamId: string;
  title: string;
  description: string;
  url: string;
  identifier: string;
  creator: Participant | null;
}> {
  const result = await gql(
    accessToken,
    `
    query GetIssueDetails($id: String!) {
      issue(id: $id) {
        identifier
        title
        description
        url
        state { name }
        team { id }
        creator { id name email }
      }
    }
  `,
    { id: issueId },
  );

  const issue = result.data?.issue;
  const creator = issue?.creator;
  return {
    status: issue?.state?.name || "Unknown",
    teamId: issue?.team?.id || "",
    title: issue?.title || "",
    description: issue?.description || "",
    url: issue?.url || "",
    identifier: issue?.identifier || "",
    creator: creator
      ? { id: creator.id, name: creator.name, email: creator.email || null }
      : null,
  };
}

/** Move issue to a specific status */
export async function moveToStatus(
  accessToken: string,
  issueId: string,
  teamId: string,
  statusName: string,
): Promise<boolean> {
  const result = await gql(
    accessToken,
    `
    query GetStatuses($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name } }
      }
    }
  `,
    { teamId },
  );

  const states = result.data?.team?.states?.nodes || [];
  const targetState = states.find(
    (s: any) => s.name.toLowerCase() === statusName.toLowerCase(),
  );

  if (!targetState) {
    console.error(
      `[linear] Status "${statusName}" not found for team ${teamId}. Available: ${states.map((s: any) => s.name).join(", ")}`,
    );
    return false;
  }

  const updateResult = await gql(
    accessToken,
    `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }
  `,
    { id: issueId, input: { stateId: targetState.id } },
  );

  if (!updateResult.data?.issueUpdate?.success) {
    console.error("[linear] Failed to move issue to status:", updateResult);
    return false;
  }
  console.log(`[linear] Moved issue ${issueId} to status: ${statusName}`);
  return true;
}
