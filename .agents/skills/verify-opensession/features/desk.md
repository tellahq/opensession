# Desk

Desk is a standing assistant session that opens over the current page. Users ask about work across Open Session, use suggested prompts, minimize the panel, open it as a full session, and optionally start a voice call.

## Sub-features

- `desk-open` opens from the floating button, command menu, or keyboard shortcut.
- `desk-text` shows the durable Desk transcript, suggested prompts, composer, model control, and clear action.
- `desk-panel` minimizes, expands, moves, and resizes the desktop panel.
- `desk-full-session` hands the durable Desk session to the full session viewer.
- `desk-voice` starts and ends a call when an OpenAI API key and voice preference are configured.
- `desk-phone` opens as a phone dialog from the root-page floating button.

## How to get to it (user POV)

- Choose the floating `Desk` control at the bottom right.
- Press Command-J, or Control-J on platforms where the app maps the control modifier.
- Open the command menu and choose `Desk`.
- On phone, return to the sidebar root first, then choose the Desk floating button beside the new-session control.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- Text verification needs no external credential. Voice needs the instance voice preference enabled and a valid OpenAI API key, which the demo seed does not provide.

- **Open Desk.** Open `/` at 1440x900, wait for button `Open the Desk`, capture the underlying page, and choose it. Wait for `dialog` named `Desk`.
- **Inspect text controls.** Capture a snapshot containing the Desk composer `Ask anything…`, suggested prompt buttons, `Clear chat`, `Open as a full session`, and `Minimise Desk`. Do not send a prompt merely to populate proof.
- **Minimize and reopen.** Choose `Minimise Desk`, require the dialog to disappear, then choose `Open the Desk` again. Existing seeded Desk content should remain because Desk is a durable session.
- **Open the full viewer.** Choose `Open as a full session`, record the resulting `/session/<id>` URL, and confirm the same Desk transcript there. This changes presentation, not session identity.
- **Check phone layout.** Open `/` at 390x844. If a session detail remains selected, choose `Back to sidebar` first. Choose `Open the Desk`, wait for `dialog` named `Desk`, and capture the phone sheet and composer.
- **Voice prerequisite.** If voice is enabled with a synthetic test credential, capture the visible call controls and connection state. Otherwise report voice as `verified-unreachable` with the missing OpenAI key and do not add a live credential.
- **Proof.** Save desktop and phone snapshots and screenshots before and after opening. For minimize or full-session behavior, also save the resulting state or URL.

## Gotchas

- Engine turns and voice connections are disabled or uncredentialed in the isolated demo. Opening Desk proves its UI and seeded durable transcript, not a successful model response or GPT-Live call.
- The phone floating button is hidden while a detail page is pushed. Return to the sidebar root before looking for `Open the Desk`.
- A voice call can continue after Desk is minimized. If a credentialed test starts one, end it before cleanup and confirm the active-call indicator clears.
- `Clear chat` mutates the durable Desk transcript. Do not use it on seeded proof unless clearing is the behavior under test.
- Desktop drag and resize depend on pointer movement. A static screenshot does not prove either interaction.
