import type { SessionSlackShare } from "../types";
import { request } from "./request";

export function shareShippedChange(
  sessionId: string,
  target: {
    repo?: string;
    branch?: string;
    channel?: string;
    message?: string;
    screenshots?: string[];
  },
): Promise<{ status: "shared" | "already_shared"; share?: SessionSlackShare }> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/share-shipped-change`,
    {
      method: "POST",
      body: target,
      label: "Couldn't share the shipped update",
    },
  );
}

/** Take a shared update back out of Slack and let the card offer it again. */
export function undoShippedChange(
  sessionId: string,
  at: string,
): Promise<void> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/share-shipped-change`,
    {
      method: "PUT",
      body: { at },
      label: "Couldn't undo the Slack message",
    },
  );
}

export function fetchShippedChangeChannels(sessionId: string): Promise<{
  channels: Array<{ id: string; name: string }>;
  defaultChannel?: string;
  canUploadImages?: boolean;
}> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/share-shipped-change`,
    {
      label: "Couldn't load Slack channels",
    },
  );
}

/**
 * The card's first draft, written from the whole session (PR description,
 * walkthrough, the agent's closing message) rather than the PR title. A null
 * message means the caller keeps its title-based fallback.
 */
export function fetchShippedChangeSuggestion(
  sessionId: string,
  target: { repo?: string; branch?: string },
  signal?: AbortSignal,
): Promise<{ message: string | null }> {
  const query = new URLSearchParams();
  if (target.repo) query.set("repo", target.repo);
  if (target.branch) query.set("branch", target.branch);
  const suffix = query.size ? `?${query}` : "";
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/share-shipped-change/suggestion${suffix}`,
    { signal, label: "Couldn't draft the Slack message" },
  );
}

export async function reconnectSlack(): Promise<void> {
  const popup = window.open("about:blank", "_blank");
  const result = await request<{ url: string }>(
    "/connections/mcp/slack/oauth/start",
    {
      method: "POST",
      body: { scope: "me" },
      label: "Couldn't reconnect Slack",
    },
  );
  if (popup) popup.location.href = result.url;
  else window.location.href = result.url;
}

export function fetchSlackChannels(sessionId: string): Promise<{
  channels: Array<{ id: string; name: string }>;
  defaultChannel?: string;
  canUploadImages?: boolean;
}> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/slack-composer`, {
    label: "Couldn't load Slack channels",
  });
}

export function openSlackComposer(
  sessionId: string,
  message: string,
): Promise<{
  id: string;
  message: string;
  channel?: string;
  images: string[];
}> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/slack-composer/open`,
    {
      method: "POST",
      body: { message },
      label: "Couldn't open the Slack composer",
    },
  );
}

export function updateSlackComposer(
  sessionId: string,
  target: {
    requestId: string;
    channel: string;
    message: string;
    screenshots: string[];
  },
  keepalive = false,
): Promise<void> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/slack-composer`, {
    method: "PATCH",
    body: target,
    keepalive,
    label: "Couldn't save the Slack draft",
  });
}

export function sendSlackComposer(
  sessionId: string,
  target: {
    requestId: string;
    channel: string;
    message: string;
    screenshots: string[];
  },
): Promise<{
  status: "sent";
  channel: { id: string; name: string };
  permalink?: string;
  ts?: string;
}> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/slack-composer`, {
    method: "POST",
    body: target,
    label: "Couldn't send to Slack",
  });
}

/** Delete a message this person just sent from the composer. */
export function undoSlackComposer(
  sessionId: string,
  target: { channel: string; ts: string },
): Promise<void> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/slack-composer/undo`,
    {
      method: "POST",
      body: target,
      label: "Couldn't undo the Slack message",
    },
  );
}

export function cancelSlackComposer(
  sessionId: string,
  requestId: string,
): Promise<void> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/slack-composer`, {
    method: "DELETE",
    body: { requestId },
    label: "Couldn't close the Slack composer",
  });
}
