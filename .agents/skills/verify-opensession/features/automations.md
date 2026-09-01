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

- Choose `Automations` in the sidebar.
- Open `/automations` or a shared `/automations/<id>` link.
- Choose `New automation`, then describe the task or select a template.
- Open an automation row to inspect its runs and edit, run, or delete it.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The demo seed contains `Nightly dependency audit` and `Deploy notes on release webhook`.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /automations --width 1440 --height 900`, then `verify-opensession browser "$RUN_ID" wait --role heading --name "Automations"`. A row for each seeded automation appears.
- **Open details.** Run `verify-opensession browser "$RUN_ID" open --route /automations/auto-demo-nightly-audit --width 1440 --height 900`. The detail view shows `Nightly dependency audit`, its cron trigger, disabled state, and three seeded runs. Separately choose the seeded row from `/automations` when the list entry point is in scope.
- **Open authoring.** Choose `New automation`. A dialog headed `New automation` appears and focus moves to the textbox named `Describe the automation`.
- **Use a template or description.** Enter a description and continue, or choose a visible template. Verify the generated form remains editable before saving.
- **Confirm persistence.** After a create, edit, or toggle through the UI, run `verify-opensession api "$RUN_ID" /api/automations | jq .`. Match the saved name, trigger, mode, and enabled state, then reopen the automation from the list.
- **Check phone layout.** Repeat the changed path at 390x844. Detail navigation uses a back action and authoring uses the phone modal layout.
- **Proof.** Capture the list before the action, the authoring or edit state, the resulting list or detail state, and the read-only API response.

## Gotchas

- Do not choose `Run now` or `retrigger` as proof of engine execution. The verification launcher disables execution and schedulers.
- The enabled switch and the row opener are separate controls. Clicking the row does not prove toggle behavior.
- `Nightly dependency audit` is deliberately disabled so demo data never schedules real work.
- Webhook URLs in demo state are synthetic. Do not send external requests to production or public ingress.
- A drafted form is not a saved automation. Reopen it from the list and read `/api/automations`.
