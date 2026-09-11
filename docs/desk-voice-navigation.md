# Desk navigation

The Desk overlay supports `show_in_app` in both text-only chat and web voice
calls, including messages typed during a call. The action accepts exactly one
`session` or `workspace`, as an ID or title/name. It resolves existing catalog
records, prefers exact names, and asks for clarification when an exact or partial
name has multiple matches. Name searches omit archived sessions and the Desk
itself. An explicit ID can open an archived session. The action never accepts a
URL, path, selector, script, or arbitrary UI operation.

For example, "Show me the deploy workspace" opens the matching workspace beside
Desk. It does not start another session or end the conversation.

## Authorization and delivery

Both paths require a verified sign-in login and a private browser capability.
Tokens remain in browser memory, never local storage, model context, tool results,
transcripts, or WebSocket broadcasts. Polling and acknowledgment require the same
verified login and token. Another login with the same first name, or another tab
without the token, cannot receive or acknowledge commands. Sign-in changes fail
closed on the next request.

Target visibility follows the signed-in team UI: sessions and workspaces are
shared, not private to their creators. This action adds no ownership-based
visibility rule and reads no transcript. If resource ACLs are introduced, the
resolver must apply those same ACLs before ID lookup and name matching.

### Voice

A capable browser requests navigation during `POST /api/desk/voice/live`. The
server returns a fresh token for that call, advertises the voice action, and
executes it on the sideband. `/api/desk/voice/live/navigation` accepts the call ID
as `connectionId` plus its token. Hanging up invalidates pending navigation and
aborts browser polling. Native Realtime clients do not receive this action.

### Text-only Desk

Before sending text, the Desk composer connects through
`/api/desk/navigation/connect` and binds the prompt's existing `requestId` through
`/bind`. The connect route requires an interactive Desk session. Registration
alone grants nothing: the WebSocket must accept that exact prompt for the same
session and verified login. The token is never added to the prompt frame or queue.

When the durable queue starts a turn, its `sourceMessageIds` select the registered
browser. A batch is eligible only when every source message was accepted from that
same browser. Mixed tabs and machine messages fail closed. The server-owned
`promptEntryId` travels with the run's MCP context, not model-controlled tool
arguments. Only that dispatch receives `opensession-desk.show_in_app`; voice tool
inventory, workflows, other sessions, and automation MCP sets do not inherit it.
An older run token cannot select a newer dispatch by supplying a prompt ID.

Turn completion revokes its tool closure and pending command. Steering from a
different browser or a machine revokes the previous turn's navigation authority
before the model receives that content. Queued turns keep their own browser
bindings. A restart loses these ephemeral grants rather than replaying navigation.

Text polling stops when no registered prompt or active turn remains. Disconnects
expire after 60 seconds without polling; unconsumed prompt bindings expire after
five minutes. Registration is bounded to 128 connections and 512 prompts. Closing
the owning component disconnects explicitly. A hidden tab refuses navigation.
Registration failures do not prevent ordinary text from being sent.

## UI behavior

Commands carry only a validated session/workspace ID, random command ID, and
expiry. Only one command can wait per connection, for at most ten seconds. The
client rejects expired/malformed commands and suppresses duplicate navigation.
Success means the owning browser's app router accepted the action. A missing app
handler, disconnect, timeout, or revoked turn returns failure; this does not claim
that every resource on the destination page has finished loading.

The selected workspace is included in the active workspace list query, so an
empty workspace or one containing only archived sessions still renders. The app
router switches the page without remounting Desk. Desktop keeps the floating Desk
open. Phone minimizes its covering sheet while the mounted conversation and voice
client remain alive. Reopen Desk to access its controls.

## Code and tests

Paths below are relative to `packages/core/opensession-server/`.

- `src/shared/desk-navigation.ts`: wire validation.
- `src/server/desk-voice-show.ts`: shared target lookup and navigation action.
- `src/server/desk-voice-navigation.ts`: pending commands and acknowledgment.
- `src/server/desk-voice-live.ts`, `src/server/routes/desk-voice.ts`: voice calls.
- `src/server/desk-text-navigation.ts`, `src/server/routes/desk-navigation.ts`:
  text browser registration, prompt admission, turn binding, and cleanup.
- `src/server/desk-navigation-mcp.ts`, `interactive-mcp.ts`, `run-rpc.ts`:
  dispatch-scoped text MCP capability.
- `src/server/ws-handlers.ts`, `run-session.ts`, `queued-steer.ts`, `host-client.ts`,
  `runner-session.ts`: authenticated intake and execution lifecycle.
- `src/frontend/components/DeskConversation.tsx`,
  `src/frontend/lib/desk-text-navigation-client.ts`: text-composer registration.
- `src/frontend/lib/desk-navigation-client.ts`, `desk-voice-client.ts`:
  polling, validation, deduplication, acknowledgment, and lifetime.
- `src/frontend/lib/desk-show.ts`, `src/frontend/AppContent.tsx`: browser-local
  router handoff and phone minimization.
- `src/frontend/hooks/useWorkspaces.ts`, `src/frontend/lib/api/workspaces.ts`,
  `src/server/routes/workspace.ts`: selected workspace projection.

Matching navigation tests cover resolution, sender/token isolation, source-message
binding, mixed-tab batches, stale tool closures, actual MCP dispatch, expiry,
steering, and disconnect races. Voice tests retain native/tool-inventory coverage.
