# Desk voice navigation

The web Desk's `show_in_app` action accepts exactly one `session` or `workspace`,
as an ID or title/name. It resolves existing catalog records, prefers exact names,
and asks for clarification when either an exact or partial name has multiple
matches. Name searches omit archived sessions and the Desk itself. An explicit
ID can open an archived session. The action never accepts a URL, path, selector,
script, or arbitrary UI operation.

## Authorization and delivery

Navigation is advertised only when a browser requests the capability during
`POST /api/desk/voice/live` and that request has a verified sign-in login. Older
web clients, unsigned instances, native Realtime clients, and generic interactive
or automation MCP tools do not receive this action.

The call owns a fresh random navigation token returned only in its creation
response. The token remains in the browser client's memory, not local storage,
model context, tool results, transcript, or a WebSocket broadcast. The browser
polls `/api/desk/voice/live/navigation` while the call is active. Both polling and
acknowledgment require the same verified login and call token. A claimed name,
another login with the same first name, or a second tab without the token cannot
receive or acknowledge commands. A sign-in change fails closed on the next
request. Hanging up invalidates pending navigation and aborts browser polling.

Target visibility follows the current signed-in team UI: sessions and workspaces
are shared, not private to their creators. This action adds no ownership-based
visibility rule and reads no transcript. If resource ACLs are introduced, the
resolver must apply those same ACLs before ID lookup and name matching.

Commands carry only a validated session/workspace ID, a random command ID, and
an expiry. Only one command can wait per call, for at most ten seconds. The client
rejects expired/malformed commands and suppresses duplicate navigation. Success
means the owning browser's app router accepted the action, not merely that a
socket send succeeded. A missing app handler, disconnect, timeout, or hangup
returns failure. This does not claim that every resource on the destination page
has finished loading.

The selected workspace is explicitly included in the active workspace list query,
so an empty workspace or one containing only archived sessions still renders.
The existing app router switches the page without remounting Desk. Desktop keeps
the floating Desk open. Phone minimizes its covering sheet while the mounted voice
client continues the call. Reopen Desk to access its call controls.

## Code and tests

- `src/shared/desk-navigation.ts`: wire validation.
- `src/server/desk-voice-show.ts`: target lookup and voice tool.
- `src/server/desk-voice-navigation.ts`: call-bound delivery and acknowledgment.
- `src/server/desk-voice-live.ts`, `src/server/routes/desk-voice.ts`: capability
  creation, tool dispatch, authenticated HTTP, and teardown.
- `src/frontend/lib/desk-navigation-client.ts`, `desk-voice-client.ts`: polling,
  validation, deduplication, acknowledgment, and call lifetime.
- `src/frontend/lib/desk-show.ts`, `src/frontend/AppContent.tsx`: browser-local
  router handoff and phone minimization.
- `src/frontend/hooks/useWorkspaces.ts`, `src/frontend/lib/api/workspaces.ts`,
  `src/server/routes/workspace.ts`: keep the selected workspace in the active
  list projection, including empty and archived workspaces.

Paths above are relative to `packages/core/opensession-server/`.
Matching `desk-voice-show`, `desk-voice-navigation`, `desk-navigation-client`, and
`desk-show` tests cover resolution, identity/token isolation, route rejection,
acknowledgments, expiry, and hangup races. Existing `desk-voice-live` tests cover
the voice tool loop and data-channel restrictions.
