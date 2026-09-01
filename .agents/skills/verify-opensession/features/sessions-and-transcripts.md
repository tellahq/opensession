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
- Choose `New session` in the sidebar or on the home view.
- Open a workspace and choose its new-session action to create a related session.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- Demo session `bks-demo-pr` exists with title `Fix flaky upload retry test`.

- **Open a direct session link.** Run `verify-opensession browser "$RUN_ID" open --route /session/bks-demo-pr --width 1440 --height 900`. Wait with `verify-opensession browser "$RUN_ID" wait --role heading --name "Fix flaky upload retry test"`. The session title and transcript appear.
- **Inspect transcript semantics.** Run `verify-opensession browser "$RUN_ID" snapshot`. The tree contains the upload retry prompt and transcript controls. Capture a screenshot after expanding any collapsed tool call through its visible button.
- **Inspect a failure.** Open `/session/bks-demo-failed`. The page identifies `Investigate memory spike in export worker` and shows its run failure instead of presenting the transcript as complete.
- **Open the global composer.** Open `/new`, then wait for `group` named `New session`. The textbox placeholder is `What do you want to work on?`. Choose `Ask mode` and verify the placeholder changes to `What do you want to find out?`.
- **Check phone layout.** Reopen `/session/bks-demo-pr` at 390x844. Capture the transcript, then focus the composer and verify its controls remain reachable without horizontal scrolling.
- **Proof.** Save before and after accessibility snapshots and screenshots. If the check creates a session, confirm its new ID through `/api/sessions` and reopen it from the sidebar before reporting persistence.

## Gotchas

- The demo instance does not prove a successful model turn. Executor and external credentials are disabled.
- A direct `/session/<id>` link proves the session view, not the sidebar or workspace entry point.
- Tool calls may start collapsed. A final screenshot without the user action does not prove expansion behavior.
- Do not send prompts merely to populate proof. Seeded transcripts already cover complete, failed, cancelled, waiting, and automation-owned states.
- On phone, controls can move into sheets or overflow menus. Their desktop location is not a valid phone selector.
