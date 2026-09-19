# Sessions and transcripts

Sessions are conversations with an agent. Users open them from a workspace or direct link, read prompts and tool calls, switch workspace panes, and start related work.

## Sub-features

- `session-open` opens a session from a sidebar workspace row or direct link.
- `session-transcript` renders user messages, assistant text, tool calls, run notices, and failure states.
- `session-workspace` switches among conversation, review, changes, and other available workspace panes.
- `session-new` opens the new-session composer from the global button, keyboard shortcut, or a workspace.
- `session-phone` keeps the transcript and composer operable at phone width.

## How to get to it (user POV)

- Choose a session under a workspace in the sidebar.
- Open a shared `/session/<id>` or `/workspace/<workspaceId>/session/<id>` link.
- Open `/new` for the global composer.
- Choose `New session` in the sidebar header, `New tab` in a workspace tab strip, or `New session in this workspace` to create a related session.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- Demo session `bks-demo-pr` exists with title `Fix flaky upload retry test`.

- **Open a direct session link.** Run `verify-opensession browser "$RUN_ID" open --route /session/bks-demo-pr --width 1440 --height 900`. Wait with `verify-opensession browser "$RUN_ID" wait --role RootWebArea --name "Fix flaky upload retry test"`. The session view carries no `heading`: the title reaches the accessibility tree as the document name, a sidebar row button, and an `image` named `Current session: <title>`. The URL settles on `/workspace/<workspaceId>/session/bks-demo-pr`.
- **Inspect transcript semantics.** Run `verify-opensession browser "$RUN_ID" snapshot`. The tree contains the upload retry prompt and transcript controls. Expand the turn's collapsed step group through its visible button, `Worked 2m · 4 steps +1 -1`, and capture the snapshot showing `expanded=true`.
- **Switch workspace panes.** Choose `Open review`. The URL becomes `/workspace/<workspaceId>/review` and a `tablist` exposes the session tab beside `Review Close Review`. Choose the session tab to return to the conversation.
- **Inspect a failure.** Open `/session/bks-demo-failed`. The page identifies `Investigate memory spike in export worker` and shows `Run failed` with its reason instead of presenting the transcript as complete.
- **Open the global composer.** Open `/new`. The composer is a `combobox` named `What do you want to work on?`, not a textbox, and the page exposes no `group` named `New session`. Choose `Ask mode`; it reports `pressed=true` and the combobox name changes to `What do you want to find out?`.
- **Create from a workspace.** In an open workspace choose `New tab`. A tab named `New session Close session` opens on a fresh `/workspace/<workspaceId>/session/<newId>` route.
- **Check phone layout.** Reopen `/session/bks-demo-pr` at 390x844. Capture the transcript, then focus the composer and verify its controls remain reachable without horizontal scrolling.
- **Proof.** Save before and after accessibility snapshots and screenshots. If the check creates a session, confirm its new ID through `/api/sessions` and reopen it from the sidebar before reporting persistence.

## Gotchas

- The demo instance does not prove a successful model turn. Executor and external credentials are disabled.
- A direct `/session/<id>` link proves the session view, not the sidebar or workspace entry point.
- `/session/<id>` redirects to the session's workspace and reopens whichever pane that workspace last showed. Re-select the session tab before reading transcript controls.
- The sidebar header's new-session button exposes no accessible name on desktop, so `click --role button --name "New session"` cannot reach it there. Use `/new`, `New tab`, or `New session in this workspace`.
- Tool calls may start collapsed. A final screenshot without the user action does not prove expansion behavior.
- Do not send prompts merely to populate proof. Seeded transcripts already cover complete, failed, cancelled, waiting, and automation-owned states.
- On phone, controls can move into sheets or overflow menus. Their desktop location is not a valid phone selector.
