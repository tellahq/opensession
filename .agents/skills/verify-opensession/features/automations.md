# Automations

Automations create fresh sessions from schedules or external events. Users inspect run history, turn an automation on or off, author one, edit it, run it now, or delete it.

## Sub-features

- `automation-list` shows each automation, trigger summary, latest run, and enabled state.
- `automation-detail` opens configuration and run history.
- `automation-toggle` persists the enabled switch.
- `automation-create` creates a scheduled, webhook, or Slack-watch automation.
- `automation-edit` saves configuration changes and deletion.
- `automation-run` starts or retriggers a run when execution is available.

## How to get to it (user POV)

- Choose `Settings`, then `Automations` in the settings rail. The list renders inside the settings overlay, not the main sidebar.
- Open `/automations` or a shared `/automations/<id>` link.
- Choose `New automation`, then describe the task or select a template.
- Open an automation row to inspect its runs and edit, run, or delete it.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The list starts empty. The demo generator writes its two automations as legacy JSON after the boot import has already closed the automations catalog, so `Nightly dependency audit` and `Deploy notes on release webhook` never reach the reader. Treat that as an open product gap and build this run's own automation instead of expecting seeded rows.
- Set `AUTO_NAME="Verification automation $RUN_ID"` so this run's mutation is unambiguous.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /automations --width 1440 --height 900`, then `verify-opensession browser "$RUN_ID" wait --role heading --name "Automations"`. Capture the empty state, `No automations yet.`, before changing anything.
- **Open authoring.** Choose `New automation`. A dialog headed `New automation` appears and focus moves to the textbox named `Describe the automation`.
- **Use a template or description.** Enter a description and choose `Draft it`, or choose a visible template button such as `Schedule, event or webhook Assistant runs once each time the trigger fires.`. Verify the generated form remains editable before saving.
- **Save one.** Fill textbox `Automation name` with `$AUTO_NAME` and textbox `Instructions: what Assistant does when triggers activate`, then choose `Create automation`. The dialog closes and the row appears as `Open $AUTO_NAME`.
- **Toggle it.** Choose the switch named `$AUTO_NAME · on`. The stored `enabled` flips to false and the switch reads `$AUTO_NAME · off`.
- **Open details.** Choose `Open $AUTO_NAME`. The URL becomes `/automations/<id>` and the row expands in place, with `Run now`, `Edit`, `Delete`, and `Close`. There is no separate detail page.
- **Confirm persistence.** After a create, edit, or toggle through the UI, run `verify-opensession api "$RUN_ID" /api/automations | jq .`. Match the saved name, trigger, mode, and enabled state, then reopen the automation from the list. There is no `GET /api/automations/<id>`; read the list.
- **Check phone layout.** Repeat the changed path at 390x844. The list keeps the row opener and enabled switch, and `Back to settings` returns to the settings section list.
- **Proof.** Capture the list before the action, the authoring or edit state, the resulting list or detail state, and the read-only API response.

## Gotchas

- Do not choose `Run now` or `retrigger` as proof of engine execution. The verification launcher disables execution and schedulers.
- The enabled switch and the row opener are separate controls, named `<name> · on` or `<name> · off` and `Open <name>`. Clicking the row does not prove toggle behavior.
- The authoring form is taller than the viewport. `click` scrolls its target into view, so drive `Create automation` by name rather than by a guessed position.
- Webhook URLs in demo state are synthetic. Do not send external requests to production or public ingress.
- A drafted form is not a saved automation. Reopen it from the list and read `/api/automations`.
